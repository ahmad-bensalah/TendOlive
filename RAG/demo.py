"""Command-line interface for the RAG requirement matching engine.

Usage:
    python demo.py
    python demo.py examples/tender_hard.json
    python demo.py --tender path/to/tender.json --output results.json
"""
import argparse
import json
import sys
from pathlib import Path

from rag import config
from rag.index import build_index, index_up_to_date
from rag.retriever import retrieve

HERE = Path(__file__).resolve().parent
ICON = {"covered": "[OK]  ", "partial": "[~]   ", "missing": "[MISS]"}


def parse_args():
    parser = argparse.ArgumentParser(
        description="OliveSoft RAG Retrieval Engine: Match tender requirements against internal capability documents."
    )
    parser.add_argument(
        "tender",
        nargs="?",
        default=str(HERE / "examples" / "tender_requirements.json"),
        help="Path to input tender JSON file (default: examples/tender_requirements.json)",
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        help="Path to save output JSON payload (default: examples/output_<tender_stem>.json)",
    )
    return parser.parse_args()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = parse_args()
    tender_path = Path(args.tender)
    if not tender_path.exists():
        sys.exit(f"Error: Tender specification not found: {tender_path}")

    try:
        data = json.loads(tender_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        sys.exit(f"Error: Invalid JSON in {tender_path}: {err}")

    # Standardize input: extract requirements dictionary if wrapped in a tender record
    if isinstance(data.get("requirements"), dict):
        data = {**data["requirements"], "sector": data.get("sector"), "client": data.get("client")}

    if not index_up_to_date():
        print("Knowledge base index out of date. Rebuilding vector and keyword indexes...")
        build_index()

    out = retrieve(data)

    print("\n" + "=" * 90)
    print("OLIVESOFT EVIDENCE-BASED RAG RETRIEVAL ENGINE")
    print("=" * 90)
    print(f"Embedding Model : {config.EMBEDDING_MODEL}")
    print(f"Retrieval Mode  : Hybrid (Dense Vector + BM25 Lexical via RRF)")
    print(f"Reranker Model  : {config.RERANKER_MODEL or 'None (Disabled)'}")
    print("=" * 90 + "\n")

    print("REQUIREMENTS COMPLIANCE MATRIX")
    print("-" * 90)
    for row in out["requirements_matrix"]:
        opt_flag = "" if row["mandatory"] else " (optional)"
        print(f"{ICON[row['status']]} [{row['category'].upper()}] {row['requirement']}{opt_flag}")
        doc_info = f" -> {row['best_doc']}" if row["best_doc"] else ""
        print(f"         Status: found {row['found']}/{row['needed']} via {row['method']}{doc_info}")
        if row["evidence"]:
            print(f"         Proof: \"{row['evidence'][:85]}\"")
        if row["closest_doc"]:
            print(f"         Nearest capability: {row['closest_doc']}")

    print("\nCOMPOSITE FIT SCORES")
    print("-" * 40)
    for dimension, score in out["fit_score"].items():
        score_repr = f"{score}%" if score is not None else "N/A"
        print(f"  {dimension:<20} {score_repr:>8}")

    print("\nPROPOSAL EVIDENCE CITATIONS")
    print("-" * 90)
    for match in out["matches"][:10]:
        print(f"  [{match['type'].upper():<14}] {match['doc_id']:<35} Supports: {match['supports'][:35]}")

    if out["warnings"]:
        print("\nPIPELINE NOTICES & WARNINGS")
        print("-" * 90)
        for warning in out["warnings"]:
            print(f"  ! {warning}")

    out_file = Path(args.output) if args.output else HERE / "examples" / f"output_{tender_path.stem}.json"
    out_file.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nProposal synthesis payload written to: {out_file}\n")


if __name__ == "__main__":
    main()
