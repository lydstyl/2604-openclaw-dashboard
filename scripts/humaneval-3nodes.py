#!/usr/bin/env python3
"""run_he_3nodes.py — HumanEval pass@1 sur les 3 noeuds locaux, protocole IDENTIQUE.

Patch MACHINES du runner (display_name / api_url / modele reels) puis lance
les 3 machines EN PARALLELE (le runner utilise un ThreadPoolExecutor).

Protocole : nothink (enable_thinking=false + reasoning_effort none), max_tokens 2048,
timeout 300 s, reasoning_fallback en filet. C'est le protocole des runs HumanEval
historiques du vault pour les modeles non-thinking.

usage: run_he_3nodes.py <nb_problemes> <output_dir>   (ex: 50  /tmp/he-3nodes)
"""
import importlib.util
import sys

RUNNER = "/home/lydstyl/llm-bench/humaneval-runner.py"
spec = importlib.util.spec_from_file_location("hr", RUNNER)
hr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hr)

n = int(sys.argv[1])
out = sys.argv[2]

COMMON = {
    "timeout": 300,
    "max_tokens": 2048,
    "stop": [],
    "server_script": None,
    "chat_template_kwargs": {"enable_thinking": False},
    "reasoning_effort": "none",
    "reasoning_fallback": True,
}

MACHINES = {
    "gabriel": ("PC Gabriel (Strata) — Qwen3.8-Flash-Next 177B IQ3_XXS", "http://192.168.3.224:8080/v1/chat/completions", "qwen3.8-flash-next-iq3_xxs"),
    "louis":   ("PC Louis — Swift-1.5-Qwen3.8-27B-Q6_K",                "http://192.168.3.206:8080/v1/chat/completions", "Swift-1.5-Qwen3.8-27B-Q6_K.gguf"),
    "marie":   ("PC Marie — Swift-1.5-Qwen3.8-27B-Q4_K_M",              "http://192.168.3.57:8080/v1/chat/completions",  "Swift-1.5-Qwen3.8-27B-Q4_K_M.gguf"),
}
for key, (disp, url, model) in MACHINES.items():
    entry = dict(COMMON)
    entry.update(display_name=disp, api_url=url, model=model)
    hr.MACHINES[key] = entry

sys.argv = ["humaneval-runner.py", "--machines", ",".join(MACHINES),
            "--problems", "0-%d" % (n - 1), "--output", out]
print("[run_he_3nodes] 3 noeuds en parallele | problemes 0-%d | nothink | -> %s" % (n - 1, out), flush=True)
hr.main()
