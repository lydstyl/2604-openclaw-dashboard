#!/usr/bin/env python3
"""Mesure du debit des 3 LLM locaux (t/s) a grand contexte -> data/llm-speed.json.

Alimente les barres des cartes PC du dashboard openclaw-dash (port 8085).

Usage:
  python3 scripts/bench-llm-speed.py                     # mesure a ~100k ctx (defaut), 3 noeuds en parallele
  python3 scripts/bench-llm-speed.py --ctx 100000        # cible de contexte en tokens
  python3 scripts/bench-llm-speed.py --convert f.json    # convertit un resultat brut existant, sans rien mesurer

Mesure officielle = le bloc "timings" renvoye par le serveur lui-meme
(prompt_n / prompt_ms / predicted_n / predicted_ms) : aucun chiffre estime de tete.
Le contexte reellement traite (prompt_n) est celui des tokens NON deja en cache.

DEUX REGIMES MESURES (15/10/2026) — pourquoi c'est indispensable :
le t/s affiche par llama.cpp inclut la speculation ; il depend donc du TAUX
D'ACCEPTATION du drafter, qui depend du CONTENU genere. Mesure du 15/10 sur le
meme prompt de remplissage a 28k : texte libre 27,9 t/s (2,6 tok/step) contre
enumeration d'entiers 84,0 t/s (7,8 tok/step) sur Louis — pour des steps/s
IDENTIQUES (10,59 vs 10,86). Un seul chiffre de t/s ne veut donc rien dire.
  - regime "texte"    : redaction libre  -> t/s que l'utilisateur voit en pratique
  - regime "repetitif": sortie tres previsible -> borne haute
  - steps_s           = (predicted_n - draft_accepted)/predicted_ms : vitesse de
    DECODE PURE, insensible a l'acceptation -> la seule metrique comparable
    entre deux noeuds (reproductible a +/-0,02 entre deux passes).
"""
import argparse, json, os, random, sys, threading, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "..", "data", "llm-speed.json")
RAW_FILE = "/tmp/llm-speed-bench.json"

# cle = nom de la carte sur le dashboard
NODES = {
    "gabriel": {"label": "PC Gabriel", "node_name": "Harry", "ip": "192.168.3.224"},
    "louis":   {"label": "PC Louis",   "node_name": "Ron",   "ip": "192.168.3.206"},
    "marie":   {"label": "PC Marie",   "node_name": "Luna",  "ip": "192.168.3.57"},
}
PORT = 8080
MAX_TOKENS = 256
TIMEOUT_S = 1800

TAIL_FREE = ("\n\nTache finale : decris en detail, en un texte continu et sans liste, "
             "le fonctionnement d'un moteur diesel et ses differences avec un moteur essence. "
             "Developpe autant que possible.")
TAIL_REPEAT = ("\n\nEcris maintenant les nombres entiers de 1 a 300, un par ligne, "
               "sans aucun commentaire. Ne t'arrete pas avant 300.")
REGIMES = (("texte", TAIL_FREE), ("repetitif", TAIL_REPEAT))

# ~1,3 token par mot : 77000 mots visent ~100k tokens
WORDS = """the system of a large language model running on local machine with graphics
processing unit memory and context window tokens generation speed benchmark parallel
thread server process temperature layer network storage kernel driver power supply
house building street number light water time day year week person child family work
school state country city river mountain forest road car train plane boat market price
money bank account credit value service company product team member project result
data file report document page code function variable list array object string number
boolean null error warning message request response client server socket port protocol
address packet header footer middle start end begin finish continue stop pause quick
brown fox jumps over lazy dog writes reads computes allocates frees loads stores cache
buffer queue stack heap index pointer thread lock mutex signal handler callback simple
complex easy hard fast slow big small long short high low first last next previous open
close read write send receive connect disconnect start stop check verify measure test
bench score result value total average median minimum maximal sample window frame"""
WORDS = sorted(set(WORDS.split()))


def build_prompt(n_words, seed, tail):
    rnd = random.Random(seed)
    parts = ["Document de reference (remplissage volontaire), version unique %d.\n" % rnd.randrange(10 ** 12)]
    n = 0
    while n < n_words:
        parts.append(" ".join(rnd.choice(WORDS) for _ in range(16)) + ".")
        n += 16
    parts.append(tail)
    return " ".join(parts)


def call(node_key, cfg, prompt, results, max_tokens=MAX_TOKENS):
    url = "http://%s:%d/v1/chat/completions" % (cfg["ip"], PORT)
    body = {
        "model": "x",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
        # Generation FORCEE jusqu'a max_tokens : sinon une reponse courte (3 tokens)
        # rend le t/s de generation instable (il ne mesure plus le regime etabli).
        # ATTENTION : ignore_eos n'est PAS supporte par Strata (.224) -> sur ce noeud
        # c'est la consigne finale directive qui garantit une generation longue.
        "ignore_eos": True,
    }
    data = json.dumps(body).encode()
    rec = {"node": node_key, "ip": cfg["ip"], "label": cfg["label"], "ok": False}
    t0 = time.time()
    try:
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        timings = usage = model = None
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except ValueError:
                    continue
                if obj.get("model"):
                    model = obj["model"]
                if obj.get("usage"):
                    usage = obj["usage"]
                if obj.get("timings"):
                    timings = obj["timings"]
        rec["wall_s"] = round(time.time() - t0, 2)
        rec["model"] = model
        rec["usage"] = usage
        rec["timings"] = timings
        if timings:
            rec["ok"] = True
            rec["prompt_tokens"] = timings.get("prompt_n")
            rec["cached_tokens"] = timings.get("cache_n")
            rec["prefill_tps"] = round(timings.get("prompt_per_second") or 0, 1)
            rec["gen_tps"] = round(timings.get("predicted_per_second") or 0, 1)
            rec["gen_tokens"] = timings.get("predicted_n")
            rec["draft_accepted"] = "%s/%s" % (timings.get("draft_n_accepted"), timings.get("draft_n"))
            dn = timings.get("predicted_n") or 0
            acc = timings.get("draft_n_accepted") or 0
            ms = timings.get("predicted_ms") or 0
            if dn and ms:
                rec["steps_s"] = round((dn - acc) / ms * 1000, 2)
                rec["tok_per_step"] = round(dn / max(1, dn - acc), 2)
        else:
            rec["error"] = "pas de timings dans la reponse (usage=%r)" % (usage,)
    except Exception as e:  # noqa: BLE001 - on veut le motif exact dans le rapport
        rec["wall_s"] = round(time.time() - t0, 2)
        rec["error"] = "%s: %s" % (type(e).__name__, e)
    results[node_key] = rec


def to_dashboard(raw):
    """Forme compacte consommee par le dashboard (index.js -> /api/llm-speed)."""
    results = raw.get("results", [])
    ok = [r for r in results if r.get("ok") and r.get("gen_tps")]

    def regime(r, name):
        for x in r.get("regimes", []):
            if x.get("regime") == name:
                return x
        return {}

    max_gen = max([r["gen_tps"] for r in ok], default=None)
    max_steps = max([r.get("steps_s") or 0 for r in ok], default=None)
    ctx = max([r["prompt_tokens"] for r in ok], default=None)
    by_node = {}
    for r in results:
        free = regime(r, "texte")
        rep = regime(r, "repetitif")
        by_node[r["node"]] = {
            "ok": bool(r.get("ok")),
            # gen_tps = regime texte (ce que l'utilisateur voit en pratique) : c'est lui
            # qui remplit la barre ; steps_s = decode pur, comparable entre noeuds.
            "gen_tps": free.get("gen_tps"),
            "steps_s": free.get("steps_s"),
            "tok_per_step": free.get("tok_per_step"),
            "gen_tps_repeat": rep.get("gen_tps"),
            "steps_s_repeat": rep.get("steps_s"),
            "prefill_tps": r.get("prefill_tps"),
            "prompt_tokens": r.get("prompt_tokens"),
            "gen_tokens": free.get("gen_tokens") or r.get("gen_tokens"),
            "cached_tokens": r.get("cached_tokens"),
            "model": (r.get("model") or "").split("/")[-1] or None,
            "label": r.get("label"),
            "node_name": NODES.get(r["node"], {}).get("node_name"),
            "ip": r.get("ip"),
            "wall_s": r.get("wall_s"),
            "error": r.get("error"),
        }
    return {
        "ok": bool(ok),
        "source": "scripts/bench-llm-speed.py (2 regimes : texte + repetitif)",
        "measured_at": raw.get("measured_at") or time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "context_tokens": ctx,
        "max_gen_tps": max_gen,
        "max_steps_s": max_steps,
        "wall_total_s": raw.get("wall_total_s"),
        "by_node": by_node,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ctx", type=int, default=100000, help="cible de contexte en tokens (defaut 100000)")
    ap.add_argument("--max-tokens", type=int, default=256, help="tokens generes (defaut 256)")
    ap.add_argument("--convert", metavar="JSON", help="convertir un resultat brut existant sans mesurer")
    ap.add_argument("--out", default=RAW_FILE, help="ou ecrire le resultat brut (defaut %s)" % RAW_FILE)
    ap.add_argument("--no-write", action="store_true", help="ne pas ecrire data/llm-speed.json")
    args = ap.parse_args()

    if args.convert:
        with open(args.convert) as f:
            raw = json.load(f)
    else:
        # Calibration MESUREE le 08/10/2026 (vocabulaire de WORDS) : 82322 tokens pour
        # 77008 mots => 1,069 token/mot. La cible est le prompt_n renvoye par le serveur.
        n_words = max(1000, int(args.ctx / 1.069))
        sys.stderr.write("prompt cible ~%d tokens (%d mots)...\n" % (args.ctx, n_words))
        nonce = int(time.time())
        # un seul tir A LA FOIS par noeud (1 slot, Marie en a 2 : on n'en utilise qu'un)
        results = {}
        t0 = time.time()

        def worker(key, cfg):
            rec = {"node": key, "ip": cfg["ip"], "label": cfg["label"], "ok": False, "regimes": []}
            for idx, (name, tail) in enumerate(REGIMES):
                prompt = build_prompt(n_words, nonce + idx * 7 + hash(key) % 1000, tail)
                tmp = {}
                call(key, cfg, prompt, tmp, args.max_tokens)
                sub = tmp.get(key, {})
                sub["regime"] = name
                rec["regimes"].append(sub)
                if idx == 0:                     # champs racine = regime "texte" (compat ancien format)
                    for k in ("ok", "model", "prompt_tokens", "cached_tokens", "prefill_tps",
                              "gen_tps", "gen_tokens", "draft_accepted", "steps_s", "tok_per_step",
                              "wall_s", "error", "usage", "timings"):
                        if k in sub:
                            rec[k] = sub[k]
                rec["wall_s"] = round((rec.get("wall_s") or 0) + (sub.get("wall_s") or 0), 2)
            results[key] = rec

        threads = [threading.Thread(target=worker, args=(k, cfg)) for k, cfg in NODES.items()]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        raw = {
            "bench": "vitesse LLM locaux grand contexte (2 regimes)",
            "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "wall_total_s": round(time.time() - t0, 1),
            "requested_tokens": args.ctx,
            "results": [results[k] for k in NODES if k in results],
        }
        with open(args.out, "w") as f:
            json.dump(raw, f, indent=2, ensure_ascii=False)

    for r in raw.get("results", []):
        if r.get("ok"):
            print("%-8s %-34s prompt=%s tok | prefill %s t/s" % (
                r["node"], (r.get("model") or "?").split("/")[-1][:34],
                r["prompt_tokens"], r.get("prefill_tps")))
            for x in r.get("regimes", [{"regime": "?", "gen_tps": r.get("gen_tps"),
                                        "steps_s": r.get("steps_s"), "tok_per_step": r.get("tok_per_step")}]):
                print("         %-10s GEN %s t/s | %s steps/s | %s tok/step | drafts %s | wall %ss" % (
                    x.get("regime"), x.get("gen_tps"), x.get("steps_s"), x.get("tok_per_step"),
                    x.get("draft_accepted"), x.get("wall_s")))
        else:
            print("%-8s ECHEC: %s" % (r["node"], r.get("error")))

    payload = to_dashboard(raw)
    if not args.no_write:
        target = os.path.abspath(DATA_FILE)
        with open(target, "w") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        print("-> %s (max %s t/s, %s steps/s)" % (target, payload["max_gen_tps"], payload["max_steps_s"]))


if __name__ == "__main__":
    main()
