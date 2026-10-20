"""Reading real CVs: the 19 sample OliveSoft CVs (PDF made with LaTeX) in the authoritative data/cvs folder.

These CVs have sections (Profile, Professional Experience, Skills, Certifications and Awards)
instead of labelled lines, and their PDF text has export problems. No index or model needed.
"""
import re
from datetime import date
from pathlib import Path

import pytest

from rag import config, cvparse, taxonomy as tx
from rag.loader import clean_pdf_text, load_documents
from rag.profiles import rule_profile
from rag.reqparse import parse

REAL_DIR = Path(__file__).resolve().parents[2] / "data"


@pytest.fixture(scope="module")
def cvs():
    docs = [d for d in load_documents(REAL_DIR) if d.doc_type == "cv"]
    assert len(docs) == 19
    assert all(Path(d.path).parent == config.CV_DIR.resolve() for d in docs)
    assert {d.doc_id for d in docs} == {"CV_" + p.name for p in config.CV_DIR.glob("*.pdf")}
    return docs


def cv(cvs, number):
    """CV by number: CV_03.pdf or CV_03_Firstname_Lastname.pdf."""
    key = f"CV_{number:02d}"
    found = [d for d in cvs if d.doc_id == f"{key}.pdf" or d.doc_id.startswith(key + "_")]
    assert found, f"{key} not found"
    return found[0]


def test_pdf_text_is_repaired():
    raw = "textbfFacult´ e des Sciences\n\x88Processed ¿15TB with ¡200ms latency, a 3 Öreduction, **12k** users"
    out = clean_pdf_text(raw)
    assert out.startswith("Faculté des Sciences")
    assert ">15TB" in out and "<200ms" in out and "3× reduction" in out and "12k users" in out
    assert "\x88" not in out and "textbf" not in out and "**" not in out
    # LaTeX T1 font codes, a broken \\hfill ("ill") before dates, kerning read as spaces
    out = clean_pdf_text("Data Engineer ill July 2023 \x15 Present\nApache Air\x1dow\nCertifications and A wards\n"
                         "A WS Certified, BI T eam Lead. A web app.")
    assert "Data Engineer July 2023 – Present" in out and "Airflow" in out
    assert "Certifications and Awards" in out and "AWS Certified" in out and "Team Lead" in out
    assert "A web app" in out
    # LaTeX math printed as text, cut at a line end, and a "%" before the first skills line
    out = clean_pdf_text("\x88 Built a pipeline (Kafka $\nrightarrow$ Spark $\nrightarrow$ PostgreSQL), a 3$\n"
                         "times$ reduction.\nSkills\n% Cloud Platforms: AWS, Azure\n\x88 Cut downtime by 15\n%.")
    assert "Built a pipeline (Kafka → Spark → PostgreSQL), a 3× reduction." in out
    assert "\nCloud Platforms: AWS, Azure\n" in out and out.endswith("by 15\n%.")


# Lines as pypdf gives them for a LaTeX CV (after clean_pdf_text): a bullet item starts with a
# space, and a sentence that does not fit goes on at the start of the next line.
WRAPPED_CV = """Mateo Silva
City, Country candidate.email@example.com +000 000 0000
Profile
Product Owner specialized in AI and Generative AI with a proven track record of turning business ideas into scalable, high-
impact solutions. Experienced in AI product strategy, Agile/Scrum leadership, and end-to-end LLM deployment, I bridge
product, technology, and market needs to deliver measurable value.
Professional Experience
Product Owner – Responsable produit February 2026 – Present
OliveSoft, Sfax
 Managed the full product lifecycle of a B2 B e-commerce platform serving 120+ enterprise clients, increasing monthly active
users by 35 % within six months.
 Mentored 4 junior engineers, leading weekly code-review sessions that increased code quality metrics (code coverage) by 15
%.
 Produced comprehensive documentation in Confluence and managed release pipelines through Git, enabling seamless pro-
duction deployment.
Business Analyst July 2023 – August 2023
Digix, Tunis
Skills
Cloud Platforms: AWS, Microsoft Azure, Google Cloud
Tools: Python, Postman, REST/SOAP APIs, N8N, Talend, Jira, Confluence, Docker, Git, Kubernetes, Terraform, Ansible, Power
BI
Programming: Python, SQL"""


def test_wrapped_pdf_lines_become_whole_sentences():
    out = cvparse.join_wrapped_lines(WRAPPED_CV).splitlines()
    assert out == [
        "Mateo Silva",
        "City, Country candidate.email@example.com +000 000 0000",
        "Profile",
        "Product Owner specialized in AI and Generative AI with a proven track record of turning business ideas "
        "into scalable, high-impact solutions.",
        "Experienced in AI product strategy, Agile/Scrum leadership, and end-to-end LLM deployment, I bridge "
        "product, technology, and market needs to deliver measurable value.",
        "Professional Experience",
        "Product Owner – Responsable produit February 2026 – Present",
        "OliveSoft, Sfax",
        "Managed the full product lifecycle of a B2 B e-commerce platform serving 120+ enterprise clients, "
        "increasing monthly active users by 35 % within six months.",
        "Mentored 4 junior engineers, leading weekly code-review sessions that increased code quality metrics "
        "(code coverage) by 15 %.",
        "Produced comprehensive documentation in Confluence and managed release pipelines through Git, "
        "enabling seamless production deployment.",
        "Business Analyst July 2023 – August 2023",
        "Digix, Tunis",
        "Skills",
        "Cloud Platforms: AWS, Microsoft Azure, Google Cloud",
        "Tools: Python, Postman, REST/SOAP APIs, N8N, Talend, Jira, Confluence, Docker, Git, Kubernetes, "
        "Terraform, Ansible, Power BI",
        "Programming: Python, SQL"]
    # The sections and the jobs read from them do not change.
    assert [k for k, _ in cvparse.sections(WRAPPED_CV)] == [k for k, _ in cvparse.sections("\n".join(out))]
    assert cvparse.experience_entries("\n".join(out)) == cvparse.experience_entries(WRAPPED_CV)


def test_sentences_are_split_but_not_at_abbreviations():
    assert cvparse.split_sentences("Built a Talend job. Reduced costs by 20 %.") == [
        "Built a Talend job.", "Reduced costs by 20 %."]
    assert cvparse.split_sentences("Holds an M.Sc. Computer Science degree, e.g. Python and SQL.") == [
        "Holds an M.Sc. Computer Science degree, e.g. Python and SQL."]
    assert cvparse.split_sentences("Selected among 5 LLMs (OpenAI, Gemini, etc.) and Mistral.") == [
        "Selected among 5 LLMs (OpenAI, Gemini, etc.) and Mistral."]


def _pdf_text(path):
    from pypdf import PdfReader
    return clean_pdf_text("\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages))


def test_real_cv_lines_keep_every_section_and_word():
    """On the 19 CVs, joining lines loses no text and moves nothing to another section."""
    def letters(lines):   # the letters and digits of a section, in order
        return re.sub(r"[^0-9a-z]", "", tx.normalize(" ".join(lines)))

    for path in sorted(config.CV_DIR.glob("*.pdf")):
        before = _pdf_text(path)
        after = cvparse.join_wrapped_lines(before)
        old, new = cvparse.sections(before), cvparse.sections(after)
        assert [k for k, _ in old] == [k for k, _ in new], path.name
        assert [letters(lines) for _, lines in old] == [letters(lines) for _, lines in new], path.name
        assert len(after.splitlines()) < len([ln for ln in before.splitlines() if ln.strip()]), path.name
        assert not any(ln.startswith("%") for ln in after.splitlines()), path.name


def test_real_cv_lines_are_whole_sentences(cvs):
    lines = cv(cvs, 12).text.splitlines()
    # Run 3 quoted "users by 35 % within six months." for "vector database".
    assert "users by 35 % within six months." not in lines
    assert ("Managed the full product lifecycle of a B2 B e-commerce platform serving 120+ enterprise clients, "
            "increasing monthly active users by 35 % within six months.") in lines
    assert ("Integrated LangChain and Pinecone vector databases to power semantic search and Retrieval-Augmented "
            "Generation, cutting content-generation latency by 55 %.") in lines
    assert "AI & Machine Learning: LLM fine-tuning, Retrieval-Augmented Generation, LangChain, Prompt Engineering" in lines
    # Run 3 quoted "% Programming: Apex, LWC, ..." for "Salesforce integration".
    assert "Programming: Apex, LWC, JavaScript, SOQL, SOSL, HTML/CSS, SQL" in cv(cvs, 8).text.splitlines()
    assert cv(cvs, 1).summary.startswith("Cloud Infrastructure Engineer with over three years of experience "
                                         "designing, automating, and operating scalable Kubernetes-based platforms")


def test_sections_are_found():
    text = "Jane Doe\nTunis\nProfile\nData Engineer with 4+ years of experience.\nSkills\nPython\n" \
           "Certifications and Awards\nGoogle Cloud Professional Data Engineer"
    keys = [k for k, _ in cvparse.sections(text)]
    assert keys == ["top", "profile", "skills", "certifications"]
    assert cvparse.person_name(text) == "Jane Doe"
    assert cvparse.headline(text) == "Data Engineer"
    assert cvparse.person_name("A va Thompson\nTunis\nProfile\nx") == "Ava Thompson"
    assert cvparse.heading("Professional Exp erience") == "experience"


def test_years_from_job_dates():
    text = ("Professional Experience\n"
            "Data Engineer Jan 2020 – Dec 2021\n"
            "Data Engineer Jan 2021 – Present\n"        # overlap counted once
            "Data Intern June 2019 – August 2019\n")     # internships do not count
    assert cvparse.years_from_dates(text, today=date(2024, 12, 15)) == 5
    assert cvparse.current_job_title(text) == "Data Engineer"


def test_title_and_summary_of_a_real_cv(cvs):
    d = cv(cvs, 1)
    assert d.title.endswith(" - Cloud Infrastructure Engineer")
    assert d.summary.startswith("Cloud Infrastructure Engineer with over three years")


def test_certifications_come_from_the_certifications_section(cvs):
    p = rule_profile(cv(cvs, 1))
    assert {"CKA", "AWS Solutions Architect"} <= set(p["certifications"])
    # CV 18 talks about ISO 27001 work, but no certificate is listed: not certified.
    assert "ISO 27001" not in rule_profile(cv(cvs, 18))["certifications"]
    # CV 12 lists "Scrum Master" as a skill only; CV 14 holds the certificate.
    assert "Scrum Master (PSM/CSM)" not in rule_profile(cv(cvs, 12))["certifications"]
    assert "Scrum Master (PSM/CSM)" in rule_profile(cv(cvs, 14))["certifications"]
    # CV 14 holds the CSM (Scrum Alliance), not the PSM (Scrum.org); CV 04 the PSPO.
    assert "Certified Scrum Master (CSM)" in rule_profile(cv(cvs, 14))["certifications"]
    assert "Professional Scrum Master (PSM)" not in rule_profile(cv(cvs, 14))["certifications"]
    assert "Professional Scrum Product Owner (PSPO)" in rule_profile(cv(cvs, 4))["certifications"]
    # One Azure certificate per exam: CV 15 has the fundamentals, not the architect exam.
    p15 = rule_profile(cv(cvs, 15))["certifications"]
    assert "Azure Fundamentals (AZ-900)" in p15 and "Azure Solutions Architect (AZ-305)" not in p15
    # One Salesforce certificate per job: CV 04 is the administrator, CV 08 the developer.
    assert "Salesforce Administrator" in rule_profile(cv(cvs, 4))["certifications"]
    assert "Salesforce Administrator" not in rule_profile(cv(cvs, 8))["certifications"]


def test_years_and_seniority(cvs):
    p1 = rule_profile(cv(cvs, 1))          # "over three years" written in words
    assert (p1["years"], p1["years_source"], p1["seniority"]) == (3, "written", "mid")
    p14 = rule_profile(cv(cvs, 14))        # "over 9 years"
    assert p14["years"] == 9 and p14["seniority"] == "senior"
    assert rule_profile(cv(cvs, 16))["seniority"] == "senior"     # Team Lead
    assert rule_profile(cv(cvs, 11))["seniority"] == "junior"     # student / apprentice
    p10 = rule_profile(cv(cvs, 10))        # no years written: counted from the job dates
    assert p10["years_source"] == "job dates" and p10["seniority"] != "senior"


def test_roles_come_from_the_current_job(cvs):
    assert "product owner" in rule_profile(cv(cvs, 12))["roles"]
    assert "business analyst" not in rule_profile(cv(cvs, 12))["roles"]  # was a BA in 2023
    assert "devops" not in rule_profile(cv(cvs, 14))["roles"]            # was DevOps before
    assert "developer" in rule_profile(cv(cvs, 8))["roles"]


def test_implied_skills():
    assert "etl" in tx.expand_skills(["talend"])
    assert "big data" in tx.expand_skills(["databricks"])   # databricks -> spark -> big data


def test_node_js_is_not_read_from_cluster_nodes(cvs):
    # CV 18: "a secure multi-node Apache NiFi cluster"; CV 11 uses Node.js.
    assert "node.js" not in rule_profile(cv(cvs, 18))["skills"]
    assert "node.js" in rule_profile(cv(cvs, 11))["skills"]


def test_requirement_reading():
    assert parse("Tableau dashboards", "technical").all_skills          # Power BI is not proof of Tableau
    assert not parse("React or Angular frontend", "technical").all_skills
    assert "tableau" not in parse("Tableau de bord analytique", "technical").skills
    pl300 = parse("Power BI Data Analyst certification (PL-300)", "team")
    assert pl300.certs == ["Power BI Data Analyst (PL-300)"] and not pl300.roles
