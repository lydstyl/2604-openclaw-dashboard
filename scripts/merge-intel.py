#!/usr/bin/env python3
"""merge-intel.py — fabrique data/llm-speed.json (barres des cartes PC du dashboard)
a partir des resultats BRUTS des bancs, sans jamais ressaisir un chiffre a la main.

Entrees (toutes optionnelles, defauts = sorties des harnais standards) :
  --speed   resultat brut de bench-llm-speed.py (repetable : plusieurs tirs = moyenne)
  --battery resultat brut de small_tasks.py (13 taches FR notees par code, repetable)
  --humaneval resume humaneval-summary.json (50 ou 164 problemes, pass@1)
  --out     fichier ecrit (defaut ../data/llm-speed.json)

Le JSON produit porte, par carte : gen_tps (moyenne des tirs), prefill_tps, runs[],
et intel {score, unit, bench, detail}. `max_intel_score` = 100 : la barre intelligence
affiche donc le score ABSOLU, pas un classement relatif (contrairement a la vitesse).
"""
import argparse, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "..", "data", "llm-speed.json")
NODES = ["gabriel", "louis", "marie"]


def load(p):
    with open(p) as f:
        return json.load(f)


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
                per_node[r["node"]].append({
                    "file": os.path.basename(p),
                    "gen_tps": r["gen_tps"], "prefill_tps": r.get("prefill_tps"),
                    "prompt_tokens": r.get("prompt_tokens"), "gen_tokens": r.get("gen_tokens"),
                    "draft_accepted": r.get("draft_accepted"), "model": r.get("model"),
                    "wall_s": r.get("wall_s"),
                })

    by_node = {}
    for n in NODES:
        runs = per_node[n]
        if not runs:
            continue
        gen = round(sum(r["gen_tps"] for r in runs) / len(runs), 1)
        pre = round(sum(r["prefill_tps"] for r in runs if r["prefill_tps"]) /
                    max(1, len([r for r in runs if r["prefill_tps"]])), 1)
        by_node[n] = {
            "ok": True,
            "gen_tps": gen,
            "prefill_tps": pre,
            "runs": [r["gen_tps"] for r in runs],
            "gen_tokens": runs[-1]["gen_tokens"],
            "prompt_tokens": runs[-1]["prompt_tokens"],
            "model": (runs[-1].get("model") or "").split("/")[-1] or None,
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
            parts.append("HumanEval-50 %.0f%% (%s/%s)" % (h["score_pct"], h["passed"], h["total"]))
        score = None
        if b:
            score = round(100.0 * b["score_sum"] / b["tasks"], 1)
        elif h:
            score = h["score_pct"]
        by_node[n]["intel"] = {
            "score": score,
            "unit": "%",
            "bench": "Batterie FR 13 taches" if b else "HumanEval-50",
            "detail": " · ".join(parts),
            "battery_sum": b["score_sum"] if b else None,
            "battery_tasks": b["tasks"] if b else None,
            "humaneval_pct": h["score_pct"] if h else None,
        }

    ok = [v for v in by_node.values() if v.get("ok")]
    payload = {
        "ok": bool(ok),
        "source": "scripts/bench-llm-speed.py + merge-intel.py (small_tasks.py, humaneval-runner.py)",
        "measured_at": load(speed_files[-1]).get("measured_at"),
        "context_tokens": max([v["prompt_tokens"] for v in ok if v.get("prompt_tokens")], default=None),
        "max_gen_tps": max([v["gen_tps"] for v in ok], default=None),
        "max_intel_score": 100,
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
        print("%-8s %5s t/s (tirs %s) | prefill %s | intel %s%% [%s]" % (
            n, v["gen_tps"], v["runs"], v["prefill_tps"], it.get("score"), it.get("detail")))
    print("-> %s (max %s t/s)" % (out, payload["max_gen_tps"]))


if __name__ == "__main__":
    main()
