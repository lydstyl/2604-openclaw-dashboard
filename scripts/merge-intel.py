#!/usr/bin/env python3
"""merge-intel.py — fabrique data/llm-speed.json (barres des cartes PC du dashboard)
a partir des resultats BRUTS des bancs, sans jamais ressaisir un chiffre a la main.

Entrees (toutes optionnelles, defauts = sorties des harnais standards) :
  --speed   resultat brut de bench-llm-speed.py (repetable : plusieurs tirs = moyenne)
  --battery resultat brut de small_tasks.py (13 taches FR notees par code, repetable)
  --humaneval resume humaneval-summary.json (50 ou 164 problemes, pass@1)
  --out     fichier ecrit (defaut ../data/llm-speed.json)

Le JSON produit porte, par carte :
  gen_tps / prefill_tps / runs[]  -> regime "texte" (TEXTE LIBRE) : ce que l'utilisateur
                                     voit en pratique, c'est lui qui remplit la barre
  steps_s / tok_per_step          -> vitesse de DECODE pure, insensible au taux
                                     d'acceptation du drafter : seule metrique comparable
                                     entre deux noeuds (reproductible a +/-0,02)
  gen_tps_repeat                  -> borne haute (sortie tres previsible)
  intel {score, unit, bench, detail}
`max_intel_score` = 100 : la barre intelligence affiche donc le score ABSOLU, pas un
classement relatif (contrairement a la vitesse).

Pourquoi deux regimes (mesure du 15/10/2026) : le t/s renvoye par le serveur inclut la
speculation, il depend donc du CONTENU genere. A 28k ctx, meme prompt de remplissage :
texte libre 27,9 t/s (2,6 tok/step) contre enumeration d'entiers 84,0 t/s (7,8 tok/step)
sur Louis — pour des steps/s IDENTIQUES (10,59 vs 10,86). Un t/s seul ne veut rien dire.
"""
import argparse, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "..", "data", "llm-speed.json")
NODES = ["gabriel", "louis", "marie"]


def load(p):
    with open(p) as f:
        return json.load(f)


def regime(r, name):
    """Bloc d'un regime donne ; compatible avec les JSON bruts d'avant les 2 regimes."""
    for x in r.get("regimes") or []:
        if x.get("regime") == name:
            return x
    return {}


def avg(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(sum(vals) / len(vals), 2) if vals else None


# Mesures CONNUES comme contaminees (prises avant l'ajout du detecteur de contention) :
# un autre client decodait sur le meme serveur pendant la mesure. Ecartees du calcul, avec
# leur raison, plutot que de reecrire le JSON brut.
QUARANTINE = {
    ("llm-speed-2reg.json", "marie"):
        "15/10 17:55 : les 2 slots de Marie etaient occupes par le gateway luna "
        "(6,0 t/s mesure contre 23,5 t/s en fenetre propre le meme soir)",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", action="append", default=[])
    ap.add_argument("--battery", action="append", default=[])
    ap.add_argument("--humaneval")
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()

    speed_files = a.speed or sorted(glob.glob("/tmp/llm-speed-bench*.json"))
    battery_files = a.battery or sorted(glob.glob("/tmp/res_*.json"))

    # ---- vitesse : moyenne des tirs disponibles, un tir = une ligne par noeud
    per_node = {n: [] for n in NODES}
    for p in speed_files:
        raw = load(p)
        for r in raw.get("results", []):
            if r.get("ok") and r.get("gen_tps"):
                if (os.path.basename(p), r["node"]) in QUARANTINE:
                    continue
                free = regime(r, "texte") or r
                rep = regime(r, "repetitif")
                # prefill / prompt_tokens : on prend le regime NON servi par le cache de prompt
                # (cache_n == 0) ; sinon le prefill annonce est faux (mesure : 11,9 t/s au lieu
                # de ~510 parce que le prompt venait du cache).
                cold = r
                for x in r.get("regimes") or []:
                    if (x.get("cached_tokens") or 0) == 0 and (x.get("prompt_tokens") or 0) > (cold.get("prompt_tokens") or 0):
                        cold = x
                per_node[r["node"]].append({
                    "file": os.path.basename(p),
                    "gen_tps": free.get("gen_tps"), "prefill_tps": cold.get("prefill_tps"),
                    "steps_s": free.get("steps_s"), "tok_per_step": free.get("tok_per_step"),
                    "gen_tps_repeat": rep.get("gen_tps"),
                    "steps_s_repeat": rep.get("steps_s"),
                    "prompt_tokens": cold.get("prompt_tokens"), "gen_tokens": free.get("gen_tokens"),
                    "draft_accepted": free.get("draft_accepted"), "model": r.get("model"),
                    "contended": bool(free.get("contended")), "attempts": free.get("attempt"),
                    "wall_s": r.get("wall_s"),
                })

    by_node = {}
    dropped = {}
    for n in NODES:
        all_runs = [r for r in per_node[n] if r.get("gen_tps")]
        if not all_runs:
            continue
        # une mesure prise pendant qu'un autre client decodait sur le meme serveur est ecartee
        # des qu'une mesure propre existe pour ce noeud
        clean = [r for r in all_runs if not r.get("contended")]
        runs = clean or all_runs
        dropped[n] = len(all_runs) - len(runs)
        by_node[n] = {
            "ok": True,
            "gen_tps": round(sum(r["gen_tps"] for r in runs) / len(runs), 1),
            "prefill_tps": avg([r["prefill_tps"] for r in runs]),
            "runs": [r["gen_tps"] for r in runs],
            "steps_s": avg([r["steps_s"] for r in runs]),
            "tok_per_step": avg([r["tok_per_step"] for r in runs]),
            "gen_tps_repeat": avg([r["gen_tps_repeat"] for r in runs]),
            "steps_s_repeat": avg([r["steps_s_repeat"] for r in runs]),
            "gen_tokens": runs[-1]["gen_tokens"],
            "prompt_tokens": runs[-1]["prompt_tokens"],
            "model": (runs[-1].get("model") or "").split("/")[-1] or None,
            "contended": any(r.get("contended") for r in runs),
            "draft_accepted": runs[-1].get("draft_accepted"),
            "wall_s": runs[-1].get("wall_s"),
        }

    # ---- intelligence : batterie FR 13 taches (score_sum/tasks)
    bat = {}
    for p in battery_files:
        d = load(p)
        s = d.get("summary", {})
        if not s.get("tasks"):
            continue
        label = s.get("label", os.path.basename(p))
        node = label.split("_")[0]
        node = {"gabriel": "gabriel", "louis": "louis", "marie": "marie"}.get(node, node)
        bat[node] = s

    he = {}
    if a.humaneval and os.path.exists(a.humaneval):
        for m, s in (load(a.humaneval).get("machines") or {}).items():
            he[m] = s

    for n in NODES:
        if n not in by_node:
            continue
        b, h = bat.get(n), he.get(n)
        if not b and not h:
            continue
        parts = []
        if b:
            parts.append("%s/%s taches FR" % (b["score_sum"], b["tasks"]))
        if h:
            parts.append("HumanEval %.0f%% (%s/%s)" % (h["score_pct"], h["passed"], h["total"]))
        score = None
        if b:
            score = round(100.0 * b["score_sum"] / b["tasks"], 1)
        elif h:
            score = h["score_pct"]
        by_node[n]["intel"] = {
            "score": score,
            "unit": "%",
            "bench": ("Batterie FR %s taches" % b["tasks"]) if b else "HumanEval",
            "detail": " · ".join(parts),
            "battery_sum": b["score_sum"] if b else None,
            "battery_tasks": b["tasks"] if b else None,
            "humaneval_pct": h["score_pct"] if h else None,
            "humaneval_total": h["total"] if h else None,
        }

    ok = [v for v in by_node.values() if v.get("ok")]
    payload = {
        "ok": bool(ok),
        "source": "scripts/bench-llm-speed.py (2 regimes) + merge-intel.py (small_tasks.py, humaneval-runner.py)",
        "measured_at": load(speed_files[-1]).get("measured_at"),
        "context_tokens": max([v["prompt_tokens"] for v in ok if v.get("prompt_tokens")], default=None),
        "max_gen_tps": max([v["gen_tps"] for v in ok], default=None),
        "max_steps_s": max([v["steps_s"] for v in ok if v.get("steps_s")], default=None),
        "max_intel_score": 100,
        "runs_dropped_contended": dropped,
        "speed_measured": [os.path.basename(p) for p in speed_files],
        "by_node": by_node,
    }
    out = os.path.abspath(a.out)
    with open(out, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    for n in NODES:
        v = by_node.get(n)
        if not v:
            continue
        it = v.get("intel") or {}
        print("%-8s texte %5s t/s | repetitif %5s t/s | %5s steps/s | prefill %s | intel %s%% [%s]" % (
            n, v["gen_tps"], v["gen_tps_repeat"], v["steps_s"], v["prefill_tps"],
            it.get("score"), it.get("detail")))
    print("-> %s (max %s t/s texte, %s steps/s)" % (out, payload["max_gen_tps"], payload["max_steps_s"]))


if __name__ == "__main__":
    main()
