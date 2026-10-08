#!/usr/bin/env python3
"""Batterie de "petites taches" reelles pour comparer deux LLM locaux.

Usage: small_tasks.py [port] [label] [outdir]

Mesure, pour chaque tache : latence murale, tokens de sortie, debit effectif,
et un score deterministe (0-1) ou la reponse est verifiee par du code.
Ecrit <outdir>/results_<label>.json et .md.

Echantillonnage : temperature 0.0, top_k 1, seed 42, enable_thinking=false
(pour que le modele pense ou pas, toutes les configs sont mesurees pareil).
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
LABEL = sys.argv[2] if len(sys.argv) > 2 else "case"
OUTDIR = sys.argv[3] if len(sys.argv) > 3 else "/home/gab/llm/smalltasks"
MODE = sys.argv[4] if len(sys.argv) > 4 else "nothink"
# v1.6.5 : le mode est un NIVEAU (nothink | low | medium | xhigh) ; « think » reste
# l'alias historique de « medium » pour que les campagnes passees restent lisibles.
if MODE == "think":
    MODE = "medium"
if MODE not in ("nothink", "low", "medium", "xhigh"):
    MODE = "nothink"
URL = f"http://127.0.0.1:{PORT}/v1/chat/completions"

# ---------------------------------------------------------------- document T13
_FILLER = (
    "Le bail est gere par le proprietaire et le locataire selon les clauses du contrat signe. "
    "Les charges locatives sont regularisees une fois par an sur la base des justificatifs. "
    "Le depot de garantie reste conserve pendant toute la duree du bail et ne peut etre utilise "
    "comme paiement d'un loyer. L'assurance habitation du locataire doit couvrir les degats des eaux "
    "et le recours des voisins. Les travaux d'entretien courant incombent au locataire, les travaux "
    "de structure au proprietaire. Les diagnostics techniques doivent etre joints au bail. "
)


def _doc():
    parts = ["FICHE DE SUIVI DES DOSSIERS LOCATIFS (extrait interne)\n"]
    for i in range(1, 47):
        parts.append(f"\nDossier n° {i:03d} — logement {i} rue des Peupliers, Raismes. {_FILLER}")
        if i == 31:
            parts.append("Depot de garantie verse par M. Kader : 690,00 EUR. Quittance editee.\n")
    parts.append("\nFin de l'extrait.\n")
    return "".join(parts)


TASKS = [
    dict(id="T1_classification", desc="Classer un message de locataire (2 choix)", max_tokens=24,
         prompt="Message d'un locataire : « Bonjour, je vous confirme avoir effectue le virement du "
                "loyer d'octobre ce matin, il arrivera sous 48 heures. Bonne journee. »\n"
                "Classe ce message. Reponds uniquement par : URGENT ou NON URGENT.",
         check="c_t1"),
    dict(id="T2_extraction_json", desc="Extraire un JSON d'un SMS bancal", max_tokens=220,
         prompt="Extrait les informations de ce SMS en JSON avec les cles exactes montant, date, moyen "
                "(aucune autre cle). Reponds uniquement par le JSON, sans texte autour.\n"
                "SMS : « Bonjour M. Brun, je vous ai regle 620 euros le 03/09/2026 par virement "
                "pour le loyer. »",
         check="c_t2"),
    dict(id="T3_arithmetique", desc="Prorata loyer + charges (calcul)", max_tokens=64,
         prompt="Loyer mensuel 527 euros, charges 43 euros. Le locataire a occupe le logement 21 jours "
                "sur un mois de 30 jours. Quel montant total doit-il payer ? "
                "Reponds uniquement par le nombre en euros, arrondi a 2 decimales, sans texte.",
         check="c_t3"),
    dict(id="T4_date_jour_semaine", desc="Jour de la semaine d'une date", max_tokens=24,
         prompt="Quel jour de la semaine tombe le 3 octobre 2026 ? "
                "Reponds uniquement par le nom du jour en francais, en minuscules.",
         check="c_t4"),
    dict(id="T5_instruction_format", desc="Contrainte de format stricte (3 puces <=8 mots)", max_tokens=200,
         prompt="Liste 3 avantages d'installer un LLM en local. Format impose : 3 lignes, chacune "
                "commencant par '- ', 8 mots maximum par ligne, en francais. "
                "Aucune phrase avant ou apres les lignes.",
         check="c_t5"),
    dict(id="T6_code_python", desc="Generer une fonction Python puis la tester", max_tokens=300,
         prompt="Ecris une fonction Python nommee normale(n) qui retourne la somme des carres des "
                "entiers de 1 a n. Reponds uniquement par le code, sans explication et sans commentaire.",
         check="c_t6"),
    dict(id="T7_email_relance", desc="Rediger un court email de relance (2 contraintes)", max_tokens=350,
         prompt="Redige un court email (110 mots maximum) a un locataire pour lui rappeler qu'il reste "
                "320 euros de charges impayees, a regler avant le 15 octobre 2026. Ton ferme mais "
                "courtois, en francais.",
         check="c_t7"),
    dict(id="T8_resume_2_phrases", desc="Resumer en exactement 2 phrases", max_tokens=250,
         prompt="Resume le texte suivant en exactement 2 phrases.\n\n"
                "Le depot de garantie d'un bail d'habitation ne peut depasser un mois de loyer hors "
                "charges pour un logement vide. Il est restitue dans le mois suivant la remise des cles "
                "si l'etat des lieux de sortie est conforme a l'etat des lieux d'entree. En cas de "
                "degradations, le bailleur peut retenir les sommes justifiees par des devis ou des "
                "factures, et doit conserver les justificatifs a disposition du locataire pendant deux "
                "ans. Le locataire peut contester ces retenues devant la commission departementale de "
                "conciliation, puis devant le juge des contentieux de la protection.",
         check="c_t8"),
    dict(id="T9_traduction", desc="Traduire une phrase FR -> EN", max_tokens=80,
         prompt="Traduis en anglais : « Le loyer sera preleve le 5 de chaque mois. » "
                "Reponds uniquement par la traduction.",
         check="c_t9"),
    dict(id="T10_routage_outil", desc="Choisir le bon outil (4 choix)", max_tokens=24,
         prompt="Quel outil faut-il utiliser pour : « creer un brouillon Gmail pour repondre a un "
                "locataire » ? Choisis UN outil parmi : google-calendar, email, dokimo, google-sheets. "
                "Reponds uniquement par le nom de l'outil.",
         check="c_t10"),
    dict(id="T11_categorisation", desc="Categoriser une ligne bancaire (5 choix)", max_tokens=24,
         prompt="Categorise cette ligne bancaire : « PRLV SEPA DOKIMO LOYER 527,00 ». "
                "Choisis parmi : LOYER ENCAISSE, CHARGES, IMPOT, ASSURANCE, AUTRE. "
                "Reponds uniquement par la categorie.",
         check="c_t11"),
    dict(id="T12_hallucination", desc="Refuser de repondre sans l'information", max_tokens=32,
         prompt="Quel est le montant exact du loyer du locataire M. Dupont dans le dossier de Gabriel "
                "Brun ? Si l'information ne t'est pas fournie, reponds exactement : JE NE SAIS PAS",
         check="c_t12"),
    dict(id="T13_long_prefill", desc="Retrouver un chiffre dans un long document", max_tokens=24,
         prompt=_doc() + "\n\nQuestion : d'apres le document ci-dessus, quel est le montant du depot de "
                         "garantie verse par M. Kader ? Reponds uniquement par le nombre en euros.",
         check="c_t13"),
]

_WD = {"lundi": 0, "mardi": 1, "mercredi": 2, "jeudi": 3, "vendredi": 4, "samedi": 5, "dimanche": 6}


def _norm(s):
    return re.sub(r"\s+", " ", s.strip().lower())


def c_t1(c, e):
    s = _norm(c).strip(" .!*\"'`")
    if s in ("non urgent", "non-urgent", "nonurgent"):
        return 1.0, "exact"
    if "non urgent" in s or "non-urgent" in s:
        return 0.5, "bon choix + texte parasite"
    if "urgent" in s:
        return 0.0, "mauvais choix (urgent)"
    return 0.0, "hors bareme"


def c_t2(c, e):
    m = re.search(r"\{.*\}", c, re.S)
    if not m:
        return 0.0, "pas de JSON"
    try:
        d = json.loads(m.group(0))
    except Exception as ex:
        return 0.0, f"JSON invalide ({ex})"
    if not isinstance(d, dict):
        return 0.0, "JSON non-objet"
    keys = set(d.keys())
    ok = 0
    notes = []
    if keys == {"montant", "date", "moyen"}:
        ok += 1
        notes.append("cles exactes")
    else:
        notes.append(f"cles={sorted(keys)}")
    flat = json.dumps(d, ensure_ascii=False).lower()
    if "620" in flat:
        ok += 1
    else:
        notes.append("620 absent")
    if "03/09/2026" in flat or "03-09-2026" in flat or "3/9/2026" in flat:
        ok += 1
    else:
        notes.append("date absente")
    if "virement" in flat or "transfer" in flat:
        ok += 1
    else:
        notes.append("moyen absent")
    return round(ok / 4, 2), "; ".join(notes)


def c_t3(c, e):
    nums = re.findall(r"\d+(?:[.,]\d+)?", c.replace("\u202f", "").replace(" ", ""))
    for n in nums:
        try:
            v = float(n.replace(",", "."))
        except ValueError:
            continue
        if abs(v - 399.0) <= 0.6:
            return 1.0, "399.00 +/- arrondi"
    return 0.0, f"attendu 399.00, lu {nums[:4]}"


def c_t4(c, e):
    s = _norm(c).strip(" .!*\"'`")
    if s == "samedi":
        return 1.0, "samedi"
    return 0.0, f"attendu samedi, lu {s[:40]!r}"


def c_t5(c, e):
    lines = [l for l in c.strip().split("\n") if l.strip()]
    if len(lines) != 3:
        return 0.0, f"{len(lines)} lignes (3 attendues)"
    sc = 0.0
    if all(l.lstrip().startswith("- ") for l in lines):
        sc += 0.4
    wc = [len(l.strip()[2:].split()) for l in lines]
    if all(w <= 8 for w in wc):
        sc += 0.6
        return sc, f"3 puces, mots={wc}"
    return sc, f"mots={wc} (max 8)"


def c_t6(c, e):
    txt = re.sub(r"```[a-zA-Z]*", "", c).replace("```", "")
    m = re.search(r"def\s+normale\s*\(.*?(?=\ndef\s|\Z)", txt, re.S)
    code = m.group(0) if m else txt
    prog = code + "\nimport json as _j\nprint(_j.dumps([normale(3), normale(10)]))"
    try:
        p = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=20)
    except Exception as ex:
        return 0.0, f"exec KO ({ex})"
    if p.returncode != 0:
        return 0.0, f"erreur python: {p.stderr.strip().splitlines()[-1][:70] if p.stderr.strip() else '?'}"
    try:
        v = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        return 0.0, f"sortie illisible {p.stdout[:40]!r}"
    if v == [14, 385]:
        return 1.0, "14 et 385 OK"
    return 0.0, f"valeurs {v} (attendu [14, 385])"


def c_t7(c, e):
    words = len(c.split())
    sc = 0.0
    notes = []
    if words <= 110:
        sc += 0.25
    else:
        notes.append(f"{words} mots")
    if "320" in c:
        sc += 0.25
    else:
        notes.append("montant absent")
    if re.search(r"15\s*(octobre|/10/2026|/10|\.10)", c, re.I):
        sc += 0.25
    else:
        notes.append("date absente")
    if re.search(r"\b(bonjour|madame|monsieur|m\.)\b", c, re.I):
        sc += 0.25
    else:
        notes.append("pas de formule")
    return sc, ("OK" if not notes else "; ".join(notes))


def c_t8(c, e):
    ph = [p for p in re.split(r"[.!?]+", c) if p.strip()]
    if len(ph) == 2:
        return 1.0, "2 phrases"
    return 0.0, f"{len(ph)} phrases (2 attendues)"


def c_t9(c, e):
    s = _norm(c)
    hits = sum(("rent" in s, "month" in s, bool(re.search(r"\b5(th)?\b", s))))
    if hits == 3:
        return 1.0, "OK"
    return round(hits / 3, 2), f"{hits}/3 mots-cles"


def c_t10(c, e):
    s = _norm(c).strip(" .!*\"'`")
    return (1.0, "email") if s == "email" else (0.0, f"lu {s[:40]!r}")


def c_t11(c, e):
    s = _norm(c).strip(" .!*\"'`")
    return (1.0, "LOYER ENCAISSE") if s == "loyer encaisse" else (0.0, f"lu {s[:40]!r}")


def c_t12(c, e):
    s = _norm(c).upper()
    if "JE NE SAIS PAS" in s:
        return 1.0, "refus correct"
    if re.search(r"\d{3,}", s):
        return 0.0, "a invente un montant"
    return 0.0, "n'a pas refuse"


def c_t13(c, e):
    return (1.0, "690") if "690" in c else (0.0, f"lu {_norm(c)[:50]!r}")


CHECKERS = {k: v for k, v in globals().items() if k.startswith("c_t")}


def ask(prompt, max_tokens, timeout=900):
    if MODE != "nothink":
        # le niveau voyage dans les DEUX formes : `chat_template_kwargs.reasoning_effort`
        # est lu par le template Qwen3.8 (valeurs acceptees : xhigh | medium | low) et le
        # `reasoning_effort` de premier niveau couvre les runtimes qui n'injectent pas les
        # kwargs de template.
        kw = {"enable_thinking": True, "reasoning_effort": MODE}
        effort = MODE
        budget = max_tokens + (3000 if MODE == "medium" else 6000)
    else:
        kw = {"enable_thinking": False}
        # champ de PREMIER NIVEAU : les modeles qui ignorent enable_thinking
        # (Ternary Bonsai 2 / PrismML) ne s'eteignent qu'avec reasoning_effort
        # "none". Les autres runtimes l'ignorent -> sans effet.
        effort = "none"
        budget = max_tokens
    body = json.dumps({
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0, "top_k": 1, "seed": 42,
        "max_tokens": budget,
        "reasoning_effort": effort,
        "chat_template_kwargs": kw,
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    wall = time.time() - t0
    msg = d["choices"][0]["message"]
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or ""
    u = d.get("usage", {}) or {}
    return dict(content=content, reasoning=reasoning, reasoning_len=len(reasoning), wall=wall,
                tokens_out=u.get("completion_tokens", 0), tokens_in=u.get("prompt_tokens", 0))


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    fq = f"{LABEL}_{MODE}"
    print(f"=== petites taches — port {PORT} — {fq} — tasks {len(TASKS)} ===", flush=True)
    print(f"URL {URL}", flush=True)
    # warmup (allocation des buffers de calcul + page cache)
    try:
        w = ask("Dis bonjour en un mot.", 8)
        print(f"warmup OK ({w['wall']:.1f}s)", flush=True)
    except Exception as ex:
        print(f"WARMUP KO: {ex}", flush=True)
    results = []
    t_start = time.time()
    for t in TASKS:
        try:
            r = ask(t["prompt"], t["max_tokens"])
        except Exception as ex:
            r = dict(content="", reasoning="", reasoning_len=0, wall=0.0, tokens_out=0,
                     tokens_in=0, error=str(ex))
        graded = (r.get("content") or "").strip() or (r.get("reasoning") or "")
        if "error" in r:
            score, note = 0.0, "erreur requete"
        else:
            score, note = CHECKERS[t["check"]](graded, r)
            if not (r.get("content") or "").strip() and graded.strip():
                note = "repli sur reasoning_content ; " + note
        eff = (r["tokens_out"] / r["wall"]) if r["wall"] > 0 else 0
        row = dict(id=t["id"], desc=t["desc"], score=score, note=note,
                   wall=round(r["wall"], 2), tokens_out=r["tokens_out"], tokens_in=r["tokens_in"],
                   reasoning_len=r["reasoning_len"], tok_s=round(eff, 1),
                   empty=(not graded.strip()),
                   answer=re.sub(r"\s+", " ", graded)[:400])
        results.append(row)
        print(f"{row['id']:<22} score {score:<5} {row['wall']:>6.2f}s  "
              f"{row['tokens_out']:>4} tok  {row['tok_s']:>6.1f} t/s  {note}", flush=True)
    total = round(time.time() - t_start, 1)
    n_full = sum(1 for r in results if r["score"] == 1.0)
    avg = round(sum(r["score"] for r in results) / len(results), 3)
    lat = sorted(r["wall"] for r in results)
    summary = dict(label=fq, port=PORT, mode=MODE, tasks=len(results), total_wall_s=total,
                   score_sum=round(sum(r["score"] for r in results), 2),
                   score_avg=avg, score_full=n_full,
                   lat_median=round(lat[len(lat) // 2], 2), lat_max=round(lat[-1], 2),
                   lat_min=round(lat[0], 2))
    out = dict(summary=summary, results=results)
    jp = os.path.join(OUTDIR, f"results_{fq}.json")
    with open(jp, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n== {fq} : score {summary['score_sum']}/{len(results)} "
          f"(moy {avg}) | complet {n_full}/{len(results)} | latence med {summary['lat_median']}s "
          f"max {summary['lat_max']}s | batterie {total}s", flush=True)
    print(f"JSON -> {jp}", flush=True)


if __name__ == "__main__":
    main()
