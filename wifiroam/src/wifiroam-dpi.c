// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * wifiroam-dpi - lightweight DPI daemon for wifiroam app control.
 *
 * Receives packets via NFQUEUE (queue number 0). For devices with a
 * blocklist, checks TCP ClientHello SNI and the existing UDP port,
 * fixed-header and plaintext-domain heuristics. It does not parse
 * encrypted QUIC frames.
 *
 * Blocklist is read from /tmp/wifiroam/dpi_blocklist, written by
 * wifiroamd. Format (one line per device IP):
 *   <mac> <ip> <domain1>,<domain2>,...
 * Reload on SIGHUP.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <time.h>
#include <sys/stat.h>
#include <syslog.h>
#include <poll.h>
#include <arpa/inet.h>
#include <libnetfilter_queue/libnetfilter_queue.h>
#include <libmnl/libmnl.h>
#include <linux/netfilter.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/tcp.h>
#include <linux/udp.h>

#define DPI_QUEUE_NUM   0
#define BLOCKLIST_PATH  "/tmp/wifiroam/dpi_blocklist"
#define FLOW_CACHE_MAX  4096
#define FLOW_TTL        120     /* seconds */
#define NEIGH_REFRESH   10      /* neighbor cache refresh interval (s) */
#define BL_CHECK_INTERVAL 15    /* blocklist mtime poll interval (s) */

/* ---- blocklist: mac -> { domains[] } ---- */
typedef struct {
	char   mac[18];
	char **domains;
	int    ndom;
} blent_t;

static blent_t *g_bl = NULL;
static int      g_bl_n = 0;
static time_t   g_bl_mtime = 0;    /* last loaded blocklist mtime */

/* ---- neighbor cache: ip -> mac ---- */
typedef struct {
	char ip[46];
	char mac[18];
} neit_t;
static neit_t  *g_neigh = NULL;
static int      g_neigh_n = 0;
static time_t   g_neigh_ts = 0;

static volatile sig_atomic_t g_reload = 0;
static volatile sig_atomic_t g_stop = 0;

static void bl_free(void)
{
	int i, j;
	for (i = 0; i < g_bl_n; i++) {
		for (j = 0; j < g_bl[i].ndom; j++)
			free(g_bl[i].domains[j]);
		free(g_bl[i].domains);
	}
	free(g_bl);
	g_bl = NULL;
	g_bl_n = 0;
}

/* Load blocklist from disk: lines of "<mac> <dom1>,<dom2>,..." */
static void bl_load(void)
{
	struct stat st;
	if (stat(BLOCKLIST_PATH, &st) != 0) { bl_free(); g_bl_mtime = 0; return; }
	FILE *f = fopen(BLOCKLIST_PATH, "r");
	if (!f) { bl_free(); g_bl_mtime = 0; return; }
	g_bl_mtime = st.st_mtime;

	char line[1024];
	int cap = 16, n = 0;
	blent_t *arr = calloc(cap, sizeof(*arr));
	if (!arr) { fclose(f); return; }

	while (fgets(line, sizeof(line), f)) {
		char *p = line;
		while (*p == ' ' || *p == '\t') p++;
		if (*p == '#' || *p == '\n' || *p == '\0') continue;

		char *mac = strsep(&p, " \t");
		if (!mac || !p) continue;
		while (*p == ' ' || *p == '\t') p++;
		char *doms = p;
		size_t dl = strlen(doms);
		while (dl > 0 && (doms[dl-1] == '\n' || doms[dl-1] == '\r'))
			doms[--dl] = '\0';

		if (n >= cap) {
			cap *= 2;
			arr = realloc(arr, cap * sizeof(*arr));
			if (!arr) break;
		}
		blent_t *e = &arr[n];
		snprintf(e->mac, sizeof(e->mac), "%s", mac);
		e->domains = NULL;
		e->ndom = 0;

		char *save = NULL;
		char *tok = strtok_r(doms, ",", &save);
		while (tok) {
			char *d = strdup(tok);
			if (d) {
				e->domains = realloc(e->domains,
					(e->ndom + 1) * sizeof(char *));
				if (e->domains) e->domains[e->ndom++] = d;
				else free(d);
			}
			tok = strtok_r(NULL, ",", &save);
		}
		if (e->ndom > 0) n++;
	}
	fclose(f);
	bl_free();
	g_bl = arr;
	g_bl_n = n;
}

/* Return 1 if the blocklist file's mtime differs from the last loaded
 * version.  Used as a safety net so the daemon picks up changes even if
 * the controlling process forgets to send SIGHUP. */
static int bl_mtime_changed(void)
{
	struct stat st;
	if (stat(BLOCKLIST_PATH, &st) != 0)
		return g_bl_mtime != 0;
	return st.st_mtime != g_bl_mtime;
}

/* Find blocklist entry by MAC (case-insensitive: blocklist may be
 * upper-case while /proc/net/arp is lower-case). */
static blent_t *bl_find_mac(const char *mac)
{
	int i;
	for (i = 0; i < g_bl_n; i++)
		if (strcasecmp(g_bl[i].mac, mac) == 0)
			return &g_bl[i];
	return NULL;
}

/* Refresh IP->MAC cache.
 * /proc/net/ip6_neigh does not exist on many OpenWrt kernels, so we use
 * `ip neigh show` which returns both IPv4 and IPv6 neighbors in one go.
 * Fallback to /proc/net/arp for IPv4 if iproute2 is unavailable. */
static void neigh_refresh(void)
{
	free(g_neigh);
	g_neigh = NULL;
	g_neigh_n = 0;
	int cap = 64, n = 0;
	neit_t *arr = calloc(cap, sizeof(*arr));
	if (!arr) return;

	char line[512];

	/* Primary: `ip neigh show` covers v4 + v6.
	 * Line format: <ip> dev <iface> [lladdr <mac>] <state> */
	FILE *f = popen("ip neigh show 2>/dev/null", "r");
	if (f) {
		while (fgets(line, sizeof(line), f)) {
			char ip[46], mac[18];
			char *p = line;
			while (*p == ' ' || *p == '\t') p++;
			char *sp = strchr(p, ' ');
			if (!sp) continue;
			*sp = '\0';
			snprintf(ip, sizeof(ip), "%s", p);
			p = sp + 1;
			char *ll = strstr(p, "lladdr ");
			if (!ll) continue;            /* FAILED / NOARP entries */
			ll += 7;
			if (sscanf(ll, "%17s", mac) != 1) continue;
			if (!strchr(mac, ':') ||
			    strcmp(mac, "00:00:00:00:00:00") == 0)
				continue;
			if (n >= cap) { cap *= 2;
				arr = realloc(arr, cap * sizeof(*arr));
				if (!arr) { pclose(f); return; } }
			snprintf(arr[n].ip, sizeof(arr[n].ip), "%s", ip);
			snprintf(arr[n].mac, sizeof(arr[n].mac), "%s", mac);
			n++;
		}
		pclose(f);
	}

	/* Fallback for IPv4 only (iproute2 missing): /proc/net/arp */
	if (n == 0) {
		f = fopen("/proc/net/arp", "r");
		if (f) {
			fgets(line, sizeof(line), f);   /* header */
			while (fgets(line, sizeof(line), f)) {
				char ip[46], mac[18], flags[16];
				if (sscanf(line, "%45s %*s %15s %17s", ip, flags, mac) == 3 &&
				    strchr(mac, ':') &&
				    strcmp(mac, "00:00:00:00:00:00") != 0) {
					if (n >= cap) { cap *= 2;
						arr = realloc(arr, cap*sizeof(*arr));
						if (!arr) { fclose(f); return; } }
					snprintf(arr[n].ip, sizeof(arr[n].ip), "%s", ip);
					snprintf(arr[n].mac, sizeof(arr[n].mac), "%s", mac);
					n++;
				}
			}
			fclose(f);
		}
	}

	g_neigh = arr;
	g_neigh_n = n;
	g_neigh_ts = time(NULL);
}

/* Look up MAC for an IP, refreshing cache if stale. */
static const char *neigh_mac(const char *ip)
{
	if (!g_neigh || time(NULL) - g_neigh_ts > NEIGH_REFRESH)
		neigh_refresh();
	int i;
	for (i = 0; i < g_neigh_n; i++)
		if (strcmp(g_neigh[i].ip, ip) == 0)
			return g_neigh[i].mac;
	return NULL;
}

/* Case-insensitive suffix match: sni ends with domain (dot-anchored). */
static int sni_match(const char *sni, const char *dom)
{
	size_t sl = strlen(sni), dl = strlen(dom);
	if (sl < dl) return 0;
	if (strcasecmp(sni + sl - dl, dom) != 0) return 0;
	/* dot-anchor: either exact match or preceded by '.' */
	if (sl == dl) return 1;
	return sni[sl - dl - 1] == '.';
}

/* Check whether sni is blocked for the device with this blocklist entry. */
static int sni_blocked(blent_t *e, const char *sni)
{
	int i;
	if (!e) return 0;
	for (i = 0; i < e->ndom; i++)
		if (sni_match(sni, e->domains[i]))
			return 1;
	return 0;
}

/* ---- TLS ClientHello SNI extraction ----
 * Returns SNI length (>0) on success, 0 if no SNI / not ClientHello.
 * sni buffer must be at least 256 bytes. */
static int tls_sni(const uint8_t *d, int len, char *sni, int sni_max)
{
	int p = 0;
	if (len < 5) return 0;
	if (d[p] != 0x16) return 0;          /* Handshake record */
	p += 3;                              /* skip version */
	int rec_len = (d[p] << 8) | d[p+1]; p += 2;
	if (rec_len <= 0 || p + rec_len > len) return 0;

	if (p >= len || d[p] != 0x01) return 0;  /* ClientHello */
	p += 4;                              /* handshake type(1) + length(3) */
	if (p + 2 > len) return 0;
	p += 2;                              /* client version */
	if (p + 32 > len) return 0;
	p += 32;                             /* random */
	if (p >= len) return 0;
	int sid_len = d[p]; p += 1;          /* session id */
	if (sid_len < 0 || p + sid_len > len) return 0;
	p += sid_len;
	if (p + 2 > len) return 0;
	int cs_len = (d[p] << 8) | d[p+1]; p += 2;
	if (cs_len < 0 || p + cs_len > len) return 0;
	p += cs_len;
	if (p >= len) return 0;
	int cm_len = d[p]; p += 1;          /* compression methods */
	if (cm_len < 0 || p + cm_len > len) return 0;
	p += cm_len;
	if (p + 2 > len) return 0;
	int ext_len = (d[p] << 8) | d[p+1]; p += 2;
	if (ext_len < 0 || p + ext_len > len) return 0;

	int end = p + ext_len;
	while (p + 4 <= end) {
		int etype = (d[p] << 8) | d[p+1]; p += 2;
		int elen  = (d[p] << 8) | d[p+1]; p += 2;
		if (elen < 0 || p + elen > end) return 0;
		if (etype == 0x0000) {           /* server_name extension */
			if (elen < 5) return 0;
			int list_len = (d[p] << 8) | d[p+1]; p += 2;
			if (list_len > elen - 2) return 0;
			p += 1;                      /* name type */
			int nlen = (d[p] << 8) | d[p+1]; p += 2;
			if (nlen <= 0 || nlen > sni_max - 1 || p + nlen > end)
				return 0;
			memcpy(sni, d + p, nlen);
			sni[nlen] = '\0';
			return nlen;
		}
		p += elen;
	}
	return 0;
}

/* ByteDance private QUIC version; only inspect the fixed header. */
#define QUIC_VERSION_BYTEDANCE  0xff00001d

/* Check whether the QUIC long-header version is ByteDance's private
 * version (0xff00001d).  Only meaningful for long-header packets. */
static int quic_is_bytedance(const uint8_t *d, int len)
{
	if (len < 5) return 0;
	if ((d[0] & 0x80) == 0) return 0;        /* short header */
	uint32_t ver = ((uint32_t)d[1] << 24) | ((uint32_t)d[2] << 16) |
	               ((uint32_t)d[3] << 8) | (uint32_t)d[4];
	return ver == QUIC_VERSION_BYTEDANCE;
}

/* Search a binary payload for any blocked domain (plaintext occurrence).
 * Douyin's private UDP/443 protocol carries some fields in the clear;
 * the CRYPTO payload is encrypted but control/handshake frames may
 * contain the SNI hostname as an ASCII string. */
static int payload_has_blocked_domain(const uint8_t *d, int len, blent_t *be)
{
	if (!be || len <= 0) return 0;
	int i;
	for (i = 0; i < be->ndom; i++) {
		const char *dom = be->domains[i];
		size_t dl = strlen(dom);
		if (dl == 0 || (int)dl > len) continue;
		/* simple needle-in-haystack */
		int j;
		for (j = 0; j + (int)dl <= len; j++) {
			if (strncasecmp((const char *)(d + j), dom, dl) == 0)
				return 1;
		}
	}
	return 0;
}

/* ---- flow cache ---- */
typedef struct {
	uint32_t hash;
	int      verdict;      /* NF_ACCEPT / NF_DROP / 0 = pending */
	time_t   expires;
} fcent_t;

static fcent_t g_cache[FLOW_CACHE_MAX];

static uint32_t flow_hash(int family, const void *src, const void *dst,
                          uint16_t sp, uint16_t dp, uint8_t proto)
{
	/* normalize: always put the smaller IP first so both directions
	 * share one entry.  We only set verdict on the client->server
	 * direction; reverse packets inherit it. */
	uint32_t a = 0, b = 0;
	int i;
	if (family == AF_INET) {
		for (i = 0; i < 4; i++) a = (a << 8) | ((const uint8_t*)src)[i];
		for (i = 0; i < 4; i++) b = (b << 8) | ((const uint8_t*)dst)[i];
	} else {
		const uint32_t *s = src, *d = dst;
		for (i = 0; i < 4; i++) { a ^= s[i]; b ^= d[i]; }
	}
	if (a > b) { const void *t = src; src = dst; dst = t;
	             uint16_t tp = sp; sp = dp; dp = tp; }
	uint32_t h = proto * 2654435761u;
	const uint8_t *p = src;
	for (i = 0; i < (family == AF_INET ? 4 : 16); i++)
		h = h * 31 + p[i];
	p = dst;
	for (i = 0; i < (family == AF_INET ? 4 : 16); i++)
		h = h * 31 + p[i];
	h = h * 31 + sp;
	h = h * 31 + dp;
	return h % FLOW_CACHE_MAX;
}

static int cache_get(uint32_t h, time_t now)
{
	if (g_cache[h].verdict == 0) return -1;
	if (g_cache[h].expires < now) { g_cache[h].verdict = 0; return -1; }
	return g_cache[h].verdict;
}

static void cache_put(uint32_t h, int verdict, time_t now)
{
	g_cache[h].verdict = verdict;
	g_cache[h].expires = now + FLOW_TTL;
}

/* ---- NFQUEUE callback ---- */
static int cb(struct nfq_q_handle *qh, struct nfgenmsg *nfmsg,
              struct nfq_data *nfa, void *data)
{
	(void)nfmsg; (void)data;
	struct nfqnl_msg_packet_hdr *ph = nfq_get_msg_packet_hdr(nfa);
	if (!ph) return 0;
	uint32_t id = ntohl(ph->packet_id);

	unsigned char *payload = NULL;
	int plen = nfq_get_payload(nfa, &payload);
	if (plen <= 0) {
		nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
		return 0;
	}

	int family = ntohs(ph->hw_protocol);
	int v6 = (family == 0x86dd);
	const void *saddr, *daddr;
	uint8_t proto;
	int l4off;

	if (v6) {
		if (plen < (int)sizeof(struct ipv6hdr)) goto accept;
		const struct ipv6hdr *ip = (const void *)payload;
		saddr = &ip->saddr;
		daddr = &ip->daddr;
		proto = ip->nexthdr;
		l4off = sizeof(struct ipv6hdr);
	} else {
		if (plen < (int)sizeof(struct iphdr)) goto accept;
		const struct iphdr *ip = (const void *)payload;
		if (ip->ihl < 5) goto accept;
		l4off = ip->ihl * 4;
		saddr = &ip->saddr;
		daddr = &ip->daddr;
		proto = ip->protocol;
	}
	if (l4off >= plen) goto accept;

	uint16_t sport = 0, dport = 0;
	if (proto == IPPROTO_TCP) {
		const struct tcphdr *tcp = (const void *)(payload + l4off);
		if (l4off + (int)sizeof(struct tcphdr) > plen) goto accept;
		sport = ntohs(tcp->source);
		dport = ntohs(tcp->dest);
		int tcp_hlen = tcp->doff * 4;
		if (tcp_hlen < (int)sizeof(struct tcphdr)) goto accept;
		int payoff = l4off + tcp_hlen;
		int paylen = plen - payoff;

		uint32_t h = flow_hash(v6 ? AF_INET6 : AF_INET,
			saddr, daddr, sport, dport, proto);
		time_t now = time(NULL);
		int v = cache_get(h, now);
		if (v >= 0) { nfq_set_verdict(qh, id, v, 0, NULL); return 0; }

		/* No payload -> not ClientHello yet; accept WITHOUT marking
		 * so the real ClientHello still gets inspected next round. */
		if (paylen <= 0) {
			nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
			return 0;
		}

		char sni[256];
		blent_t *be = NULL;
		char ipstr[46];
		if (v6) inet_ntop(AF_INET6, saddr, ipstr, sizeof(ipstr));
		else    inet_ntop(AF_INET, saddr, ipstr, sizeof(ipstr));
		const char *mac = neigh_mac(ipstr);
		if (mac) be = bl_find_mac(mac);

		int snilen = tls_sni(payload + payoff, paylen, sni, sizeof(sni));
		if (snilen > 0 && be && sni_blocked(be, sni)) {
			cache_put(h, NF_DROP, now);
			nfq_set_verdict2(qh, id, NF_DROP, 0x2, 0, NULL);
			return 0;
		}
		/* Has payload but no SNI (not TLS) -> accept & mark to skip. */
		cache_put(h, NF_ACCEPT, now);
		nfq_set_verdict2(qh, id, NF_ACCEPT, 0x1, 0, NULL);
		return 0;

	} else if (proto == IPPROTO_UDP) {
		const struct udphdr *udp = (const void *)(payload + l4off);
		if (l4off + (int)sizeof(struct udphdr) > plen) goto accept;
		sport = ntohs(udp->source);
		dport = ntohs(udp->dest);
		int payoff = l4off + sizeof(struct udphdr);
		int paylen = plen - payoff;

		uint32_t h = flow_hash(v6 ? AF_INET6 : AF_INET,
			saddr, daddr, sport, dport, proto);
		time_t now = time(NULL);
		int v = cache_get(h, now);
		if (v >= 0) { nfq_set_verdict(qh, id, v, 0, NULL); return 0; }

		blent_t *be = NULL;
		char ipstr[46];
		if (v6) inet_ntop(AF_INET6, saddr, ipstr, sizeof(ipstr));
		else    inet_ntop(AF_INET, saddr, ipstr, sizeof(ipstr));
		const char *mac = neigh_mac(ipstr);
		if (mac) be = bl_find_mac(mac);

		/* Preserve the existing non-SNI UDP policy. */
		int blocked = be && paylen > 0 &&
			(dport == 443 || quic_is_bytedance(payload + payoff, paylen) ||
			 payload_has_blocked_domain(payload + payoff, paylen, be));

		if (blocked) {
			cache_put(h, NF_DROP, now);
			nfq_set_verdict2(qh, id, NF_DROP, 0x2, 0, NULL);
			return 0;
		}
		cache_put(h, NF_ACCEPT, now);
		nfq_set_verdict2(qh, id, NF_ACCEPT, 0x1, 0, NULL);
		return 0;
	}

accept:
	nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
	return 0;
}

static void on_signal(int sig)
{
	if (sig == SIGHUP) g_reload = 1;
	else g_stop = 1;
}

int main(int argc, char **argv)
{
	(void)argc; (void)argv;
	struct nfq_handle *h = nfq_open();
	if (!h) { perror("nfq_open"); return 1; }

	if (nfq_unbind_pf(h, AF_INET) < 0)
		fprintf(stderr, "nfq_unbind_pf v4: %s\n", strerror(errno));
	if (nfq_bind_pf(h, AF_INET) < 0) { perror("nfq_bind_pf v4"); return 1; }
	if (nfq_unbind_pf(h, AF_INET6) < 0)
		fprintf(stderr, "nfq_unbind_pf v6: %s\n", strerror(errno));
	if (nfq_bind_pf(h, AF_INET6) < 0) { perror("nfq_bind_pf v6"); return 1; }

	struct nfq_q_handle *qh = nfq_create_queue(h, DPI_QUEUE_NUM, cb, NULL);
	if (!qh) { perror("nfq_create_queue"); return 1; }
	if (nfq_set_mode(qh, NFQNL_COPY_PACKET, 0xffff) < 0) {
		perror("nfq_set_mode");
		return 1;
	}

	/* Use sigaction without SA_RESTART so blocking recv/poll is
	 * interrupted by SIGHUP/SIGTERM.  signal() semantics vary across
	 * libcs; sigaction is deterministic. */
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = on_signal;
	sigemptyset(&sa.sa_mask);
	sa.sa_flags = 0;            /* no SA_RESTART */
	sigaction(SIGHUP, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);

	bl_load();
	syslog(LOG_INFO, "DPI started: blocklist %d entries", g_bl_n);

	/* Write our own PID file so the controller can signal us reliably.
	 * (The shell that launched us may record the wrong PID if there is
	 * any wrapper/redirection in between.) */
	{
		FILE *pf = fopen("/tmp/wifiroam-dpi.pid", "w");
		if (pf) { fprintf(pf, "%d\n", (int)getpid()); fclose(pf); }
	}

	int fd = nfq_fd(h);
	char buf[65536];
	time_t last_bl_check = time(NULL);
	struct pollfd pfd = { .fd = fd, .events = POLLIN };
	while (!g_stop) {
		if (g_reload) { bl_load(); g_reload = 0;
			syslog(LOG_INFO, "DPI reloaded: blocklist %d entries", g_bl_n); }
		/* Safety net: poll with timeout so we periodically re-check
		 * the blocklist mtime even if SIGHUP was missed. */
		int pr = poll(&pfd, 1, BL_CHECK_INTERVAL * 1000);
		if (pr < 0) {
			if (errno == EINTR) continue;
			break;
		}
		time_t now = time(NULL);
		if (now - last_bl_check >= BL_CHECK_INTERVAL) {
			if (bl_mtime_changed()) {
				bl_load();
				syslog(LOG_INFO, "DPI auto-reloaded: blocklist %d entries", g_bl_n);
			}
			last_bl_check = now;
		}
		if (pr == 0) continue;     /* timeout, no packets */
		if (!(pfd.revents & POLLIN)) continue;
		int rv = recv(fd, buf, sizeof(buf), 0);
		if (rv < 0) {
			if (errno == EINTR) continue;
			break;
		}
		nfq_handle_packet(h, buf, rv);
	}

	nfq_destroy_queue(qh);
	nfq_close(h);
	bl_free();
	return 0;
}
