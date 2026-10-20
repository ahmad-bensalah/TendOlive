"""OliveSoft Evidence-Based RAG Retrieval Engine.

Automated capability retrieval and compliance matching of RFP tender requirements
against verified internal assets (CVs, past project records, tech stacks, client portfolios).
"""
import os

# Keep the console clean: no ChromaDB usage telemetry.
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

__version__ = "1.0.0"
