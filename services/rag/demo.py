"""Console demo: run the RAG step on a tender.

    python demo.py                                  (examples/tender_requirements.json)
    python demo.py examples/tender_hard.json
    python demo.py path/to/requirements.json

Prints the requirements matrix with evidence and the fit score, and saves the full
JSON (the input for Person 5) to ../output/rag/output_<name>.json.
"""
import json
import sys
from pathlib import Path

from rag import config
from rag.index import build_index, index_up_to_date
from rag.retriever import retrieve

HERE = Path(__file__).resolve().parent
ICON = {"covered": "[OK]  ", "partial": "[~]   ", "missing": "[MISS]"}


def main():
    # Windows consoles may not support every character found in real documents.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "examples" / "tender_requirements.json"
    if not path.exists():
        sys.exit(f"File not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    # Accept Person 2's full tender record as well as a bare requirements object.
    if isinstance(data.get("requirements"), dict):
        data = {**data["requirements"], "sector": data.get("sector"), "client": data.get("client")}

    if not index_up_to_date():
        build_index()

    out = retrieve(data)

    print(f"\nModel: {config.EMBEDDING_MODEL} | hybrid BM25+dense | reranker: {config.RERANKER_MODEL or 'off'}\n")
    print("REQUIREMENTS MATRIX")
    print("-" * 100)
    for row in out["requirements_matrix"]:
        opt = "" if row["mandatory"] else " (optional)"
        print(f"{ICON[row['status']]} [{row['category']}] {row['requirement']}{opt}")
        print(f"         found {row['found']}/{row['needed']} via {row['method']}"
              + (f" -> {row['best_doc']}" if row["best_doc"] else ""))
        if row["evidence"]:
            print(f"         evidence: \"{row['evidence'][:85]}\"")
        if row["closest_doc"]:
            print(f"         closest (not enough): {row['closest_doc']}")
    print("\nFIT SCORE")
    for k, v in out["fit_score"].items():
        print(f"  {k:<18} {v}")
    print("\nASSETS FOR THE PROPOSAL")
    for m in out["matches"][:10]:
        print(f"  {m['type']:<14} {m['doc_id']:<45} <- {m['supports'][:35]}")
    for w in out["warnings"]:
        print(f"\nWARNING: {w}")

    target = HERE.parent / "output" / "rag" / f"output_{path.stem}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nFull JSON for Person 5 saved to {target}")


if __name__ == "__main__":
    main()
