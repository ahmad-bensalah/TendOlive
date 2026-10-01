"""Shared vocabulary (English + French) used by the profile extractor and the
requirement parser. Each canonical name maps to the ways people write it.

Add a line here when a new skill or certification appears in the documents.
"""
import re
import unicodedata

SKILLS = {
    "react": ["react", "react.js", "reactjs"],
    "angular": ["angular"],
    "vue": ["vue", "vue.js"],
    "node.js": ["node.js", "nodejs", "node", "express", "nestjs"],
    "java": ["java"],
    "spring": ["spring", "spring boot", "springboot"],
    "php": ["php"],
    "laravel": ["laravel"],
    "python": ["python"],
    "typescript": ["typescript"],
    "postgresql": ["postgresql", "postgres"],
    "mysql": ["mysql"],
    "mongodb": ["mongodb", "mongo"],
    "oracle": ["oracle"],
    "rest api": ["rest api", "rest apis", "api rest", "restful", "openapi"],
    "aws": ["aws", "amazon web services"],
    "azure": ["azure"],
    "docker": ["docker"],
    "kubernetes": ["kubernetes", "k8s", "aks"],
    "ci/cd": ["ci/cd", "gitlab ci", "continuous integration"],
    "terraform": ["terraform"],
    "flutter": ["flutter"],
    "mobile development": ["mobile app", "mobile apps", "mobile application", "application mobile", "mobile developer", "mobile banking app", "mobile"],
    "react native": ["react native"],
    "power bi": ["power bi", "powerbi"],
    "airflow": ["airflow"],
    "dashboard": ["dashboard", "dashboards", "tableau de bord", "tableaux de bord"],
    "llm": ["llm", "llms", "large language model"],
    "rag": ["rag", "retrieval augmented generation", "retrieval-augmented generation"],
    "machine learning": ["machine learning", "apprentissage automatique", "ml"],
    "artificial intelligence": ["artificial intelligence", "intelligence artificielle", "ia"],
    "ux/ui design": ["ux/ui", "ui/ux", "ux", "figma", "user research"],
    "cypress": ["cypress"],
    "selenium": ["selenium"],
    "cisco": ["cisco"],
    "network": ["network", "networking", "reseau", "reseaux", "switches", "routers", "routeurs"],
    "security software": ["security software", "logiciels de securite", "antivirus", "edr", "endpoint protection"],
    "penetration testing": ["penetration testing", "pentest", "pentesting"],
    "odoo": ["odoo"],
    "erp": ["erp"],
    "training": ["training", "formation", "formations", "trainer", "formateur"],
    # data engineering and BI (added for the sample OliveSoft CVs)
    "sql": ["sql", "t-sql", "tsql", "pl/sql", "sql server"],
    "etl": ["etl", "elt", "etl/elt", "data integration", "integration de donnees"],
    "talend": ["talend"],
    "ssis": ["ssis"],
    "azure data factory": ["azure data factory", "adf"],
    "nifi": ["nifi"],
    "airbyte": ["airbyte"],
    "dbt": ["dbt"],
    "spark": ["spark", "pyspark", "apache spark"],
    "kafka": ["kafka"],
    "hadoop": ["hadoop", "hdfs", "hive"],
    "flink": ["flink"],
    "big data": ["big data", "bigdata"],
    "databricks": ["databricks"],
    "snowflake": ["snowflake"],
    "bigquery": ["bigquery", "big query"],
    "synapse": ["synapse", "azure synapse"],
    "microsoft fabric": ["microsoft fabric", "ms fabric"],
    "data warehouse": ["data warehouse", "data warehouses", "data warehousing", "datawarehouse",
                       "entrepot de donnees", "entrepots de donnees", "data lake", "data lakes",
                       "datalake", "lakehouse"],
    "tableau": ["tableau", "tableau software"],
    "looker": ["looker", "looker studio"],
    "gcp": ["gcp", "google cloud", "google cloud platform"],
    # development, cloud and DevOps
    "javascript": ["javascript", "js"],
    "html/css": ["html", "html5", "css", "css3"],
    "c#": ["c#", ".net", "dotnet", "asp.net"],
    "django": ["django"],
    "fastapi": ["fastapi"],
    "microservices": ["microservices", "microservice", "micro-services", "micro-service"],
    "linux": ["linux", "ubuntu", "debian", "red hat", "redhat", "centos"],
    "bash": ["bash", "shell scripting"],
    "powershell": ["powershell"],
    "git": ["git", "github", "gitlab", "bitbucket"],
    "jenkins": ["jenkins"],
    "github actions": ["github actions"],
    "azure devops": ["azure devops"],
    "ansible": ["ansible"],
    "helm": ["helm"],
    "infrastructure as code": ["infrastructure as code", "infrastructure-as-code", "iac"],
    "monitoring": ["monitoring", "observability", "observabilite", "prometheus", "grafana", "datadog",
                   "zabbix", "nagios"],
    "elasticsearch": ["elasticsearch", "elk", "elk stack", "opensearch", "logstash", "kibana"],
    "mlops": ["mlops", "kubeflow", "mlflow"],
    # AI
    "langchain": ["langchain"],
    "tensorflow": ["tensorflow"],
    "pytorch": ["pytorch"],
    "scikit-learn": ["scikit-learn", "sklearn"],
    # business tools and methods
    "salesforce": ["salesforce", "lightning web components", "lwc", "soql", "agentforce"],
    "power platform": ["power platform", "power automate", "power apps", "powerapps"],
    "sharepoint": ["sharepoint"],
    "jira": ["jira"],
    "agile": ["agile", "scrum", "kanban", "agilite", "methode agile", "methodes agiles"],
}

# A document that has the key skill also has these (someone who uses Talend does ETL).
# Used on documents only: a requirement asking for "Talend" still needs Talend.
IMPLIES = {
    "talend": ["etl"], "ssis": ["etl"], "nifi": ["etl"], "airbyte": ["etl"], "dbt": ["etl"],
    "azure data factory": ["etl", "azure"],
    "spark": ["big data"], "hadoop": ["big data"], "kafka": ["big data"], "flink": ["big data"],
    "databricks": ["spark", "big data"],
    "bigquery": ["gcp", "data warehouse"], "snowflake": ["data warehouse"], "synapse": ["azure", "data warehouse"],
    "microsoft fabric": ["azure"],
    "terraform": ["infrastructure as code"], "ansible": ["infrastructure as code"], "helm": ["kubernetes"],
    "jenkins": ["ci/cd"], "github actions": ["ci/cd"], "azure devops": ["ci/cd", "azure"],
    "power bi": ["dashboard"], "tableau": ["dashboard"], "looker": ["dashboard"],
    "postgresql": ["sql"], "mysql": ["sql"],
    "react": ["javascript"], "angular": ["javascript"], "vue": ["javascript"], "node.js": ["javascript"],
    "typescript": ["javascript"],
    "spring": ["java"], "laravel": ["php"], "django": ["python"], "fastapi": ["python"],
    "langchain": ["llm"], "tensorflow": ["machine learning"], "pytorch": ["machine learning"],
    "scikit-learn": ["machine learning"], "mlops": ["machine learning"],
}

CERTIFICATIONS = {
    "PMP": ["pmp", "project management professional"],
    "PRINCE2": ["prince2"],
    "ISO 27001": ["iso 27001", "iso/iec 27001", "iso27001"],
    "ITIL": ["itil"],
    "TOGAF": ["togaf"],
    "AWS Certified": ["aws certified", "aws certification", "certified aws"],
    "AWS Solutions Architect": ["aws certified solutions architect", "aws solutions architect"],
    "Azure Certified": ["az-305", "azure solutions architect", "microsoft certified azure",
                        "microsoft certified: azure", "azure certified", "azure certification",
                        "az-900", "az-104", "az-204", "az-400", "dp-203", "dp-900", "ai-900", "ai-102",
                        "azure fundamentals", "azure data fundamentals", "azure ai fundamentals"],
    "Azure Data Engineer": ["azure data engineer associate", "microsoft certified: data engineer associate",
                            "dp-203"],
    "Power BI Data Analyst (PL-300)": ["pl-300", "data analyst associate", "power bi data analyst",
                                       "powerbi data analyst"],
    "Fabric Analytics Engineer (DP-600)": ["dp-600", "fabric analytics engineer"],
    "GCP Professional Data Engineer": ["professional data engineer", "gcp professional data engineer"],
    "Google Cloud Certified": ["google cloud certified", "google cloud certification",
                               "google cloud professional"],
    "Databricks Certified": ["databricks certified", "databricks certification",
                             "databricks associate data engineer"],
    "Talend Certified": ["talend certified", "talend certification", "certification (talend)",
                         "certified talend"],
    "Airflow Certified": ["airflow certified", "airflow certification", "astronomer certification",
                          "airflow fundamentals", "airflow 3 fundamentals"],
    "Salesforce Certified": ["salesforce certified", "certified salesforce", "salesforce certification",
                             "salesforce certifie", "salesforce platform developer",
                             "salesforce marketing cloud email specialist", "agentforce specialist"],
    # Salesforce has one certificate per job: an administrator is not a developer.
    "Salesforce Administrator": ["certified salesforce administrator", "salesforce certified administrator",
                                 "salesforce administrator certification", "salesforce administrator certified"],
    "Salesforce Platform Developer": ["salesforce platform developer", "salesforce certified platform developer",
                                      "platform developer i", "platform developer ii"],
    "CKA": ["cka", "certified kubernetes administrator"],
    "CCNP": ["ccnp"],
    "CEH": ["ceh"],
    "Fortinet NSE": ["fortinet nse", "nse 4"],
    "ISTQB": ["istqb"],
    "Scrum Master (PSM/CSM)": ["psm", "professional scrum master", "csm", "certified scrum master",
                               "scrum master certified", "scrum master certification"],
    "Product Owner (PSPO/CSPO)": ["pspo", "pspoi", "professional scrum product owner", "cspo",
                                  "certified scrum product owner"],
    "Certified Trainer": ["formateur certifie", "certified trainer", "cnfcpp"],
}

ROLES = {
    "developer": ["developer", "developers", "developpeur", "developpeurs", "full-stack", "backend engineer", "front-end developer"],
    "project manager": ["project manager", "project managers", "chef de projet", "chefs de projet", "program manager"],
    "designer": ["designer", "designers"],
    "devops": ["devops"],
    "data engineer": ["data engineer", "data engineers", "ingenieur data", "ingenieurs data"],
    "cloud architect": ["cloud architect", "cloud architects", "architecte cloud"],
    "security consultant": ["cybersecurity", "security consultant", "security consultants", "securite"],
    "network engineer": ["network engineer", "network engineers"],
    "qa engineer": ["qa", "quality assurance", "tester", "testeur"],
    "trainer": ["trainer", "trainers", "formateur", "formateurs"],
    "scrum master": ["scrum master", "scrum masters"],
    "ai engineer": ["ai engineer", "ai engineers", "machine learning engineer", "machine learning engineers"],
    # added for the sample OliveSoft CVs
    "product owner": ["product owner", "product owners", "responsable produit"],
    "business analyst": ["business analyst", "business analysts", "analyste metier", "analyste fonctionnel",
                         "functional analyst"],
    "data analyst": ["data analyst", "data analysts", "analyste de donnees", "bi analyst"],
    "bi consultant": ["bi consultant", "bi consultants", "bi developer", "consultant bi", "developpeur bi",
                      "business intelligence consultant", "business intelligence developer"],
    "cloud engineer": ["cloud engineer", "cloud engineers", "cloud infrastructure engineer",
                       "cloud and devops engineer", "ingenieur cloud"],
    "data scientist": ["data scientist", "data scientists"],
    "mlops engineer": ["mlops engineer", "mlops engineers"],
    "delivery manager": ["delivery manager", "delivery managers"],
    "team lead": ["team lead", "team leader", "tech lead", "technical lead", "lead developer", "chef d'equipe"],
    "architect": ["enterprise architect", "data architect", "software architect", "architecte logiciel",
                  "architecte d'entreprise"],
}

SECTORS = {
    "public": ["public sector", "secteur public", "government", "gouvernement", "ministry", "ministere",
               "municipality", "municipalite", "public agency", "agence publique", "universite publique", "national"],
    "tourism": ["tourism", "tourisme", "hotel", "hotels"],
    "health": ["health", "sante", "hospital", "hopital"],
    "finance": ["bank", "banque", "insurance", "assurance", "finance"],
    "telecom": ["telecom"],
    "education": ["university", "universite", "education", "school"],
    "retail": ["retail", "retailer", "e-commerce"],
    "industry": ["manufacturer", "industrial", "industrie"],
}

# Words that carry no specific need. If a requirement has other words left
# after removing these and the known terms, we cannot decide it with rules alone.
GENERIC_WORDS = set("""
a an the of for in on with and or to at by as is are be au aux de des du le la les un une et ou en
pour sur avec dans par
minimum min least at-least moins plus previous prior past experience experiences experienced required
requis exigee exigees preferred prefere preferee souhaite souhaitee desired nice have must
senior seniors junior juniors mid lead confirmed confirme confirmes
certified certification certifications certifie certifiee certifies certifiees
programme programmes program programs similar similaire similaires comparable reference references
session sessions fondamentaux fundamentals basics bases introduction atelier ateliers workshop workshops pratique pratiques practical hands-on app apps
developer developers developpeur developpeurs engineer engineers ingenieur ingenieurs
project projects projet projets manager managers chef team equipe member members profile profiles
designer designers digital numerique numeriques sector secteur secteurs public publics publique
frontend front-end front end backend back-end back database base donnees hosting hebergement cloud
platform plateforme solution solutions system systems systeme systemes years ans year an
development developpement using based skills skill competences competence knowledge connaissance
expert experts specialist specialiste specialise specialises specialized
informatique informatiques it software logiciel logiciels tool tools outil outils application applications
acquisition supply fourniture implementation mise place deploiement deployment
pipeline pipelines materiel materiels hardware equipment equipments equipement equipements
microsoft google amazon apache
""".split())

def normalize(text: str) -> str:
    """lowercase, remove accents, unify quotes and spaces."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("’", "'")
    return re.sub(r"\s+", " ", text).strip()


def _find(table: dict, text: str) -> list[str]:
    t = f" {normalize(text)} "
    found = []
    for name, aliases in table.items():
        for a in aliases:
            if re.search(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])", t):
                found.append(name)
                break
    return found


def _no_dashboard_tableau(text: str) -> str:
    # French "tableau de bord" means dashboard, not the Tableau software.
    return re.sub(r"tableaux? de bords?", "dashboard", normalize(text))


def find_skills(text):
    text = _no_dashboard_tableau(text)
    found = _find(SKILLS, text)
    # "react native" also matches "react"; keep both only if plain React is written elsewhere.
    if "react native" in found and not re.search(r"react(?! native)", text):
        found.remove("react")
    return found


def expand_skills(skills):
    """Add the skills implied by the ones found (Talend -> ETL). For documents only."""
    out, todo = list(skills), list(skills)
    while todo:
        for extra in IMPLIES.get(todo.pop(), []):
            if extra not in out:
                out.append(extra)
                todo.append(extra)
    return out


def implied_by(skill):
    """Skills that imply this one: implied_by("etl") -> ["talend", "ssis", ...]."""
    return [s for s, extras in IMPLIES.items() if skill in extras]


def has_or(text):
    """True when the sentence offers a choice ("React or Angular", "React/Angular", "Java, Python")."""
    t = normalize(text)
    for table in (SKILLS, CERTIFICATIONS):   # "ci/cd", "pl/sql", "iso/iec" are names, not choices
        for aliases in table.values():
            for a in aliases:
                if "/" in a:
                    t = t.replace(a, " ")
    return bool(re.search(r"\b(or|ou)\b|\w\s*/\s*\w|,", t))


def find_certs(text):
    return _find(CERTIFICATIONS, text)


def find_roles(text):
    return _find(ROLES, text)


def find_sectors(text):
    return _find(SECTORS, text)


def strip_aliases(text: str, table: dict) -> str:
    """The normalized text without the names in this table (longest names first)."""
    t = normalize(text)
    for a in sorted((a for aliases in table.values() for a in aliases), key=len, reverse=True):
        t = re.sub(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])", " ", t)
    return t


def leftover_words(text: str) -> list[str]:
    """Words not explained by known skills, certs, roles, sectors or generic words."""
    t = _no_dashboard_tableau(text)
    # Longest names first, across all tables: "scrum master" before "scrum".
    names = {a for table in (SKILLS, CERTIFICATIONS, ROLES, SECTORS) for aliases in table.values() for a in aliases}
    for a in sorted(names, key=len, reverse=True):
        t = re.sub(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])", " ", t)
    words = re.findall(r"[a-z][a-z0-9+#./-]*", t)
    return [w for w in words if w.strip("./-") not in GENERIC_WORDS and len(w.strip("./-")) > 1]
