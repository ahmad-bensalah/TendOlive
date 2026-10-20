# n8n 2.41.3 (the tested version) + our 4 workflows, generated here from build.js, + the init script (init/).
# The deck agents' 9 workflows are NOT baked in: init reads them at start from services/proposal-studio/workflows, mounted
# read-only at /data/rfp-studio. Build context: n8n/.
FROM docker.n8n.io/n8nio/n8n:2.41.3

USER root
COPY build.js /opt/rfp/pipeline/build.js
COPY src/ /opt/rfp/pipeline/src/
COPY llm.json /opt/rfp/llm.json
COPY init/init.js /opt/rfp/init.js
COPY init/entrypoint.sh /opt/rfp/entrypoint.sh
# build.js writes dist/ next to itself; then check that every Config / Refine patch of init.js applies and that llm.json
# matches the model nodes (the build fails otherwise). No n8n command here: it would put an encryption key in the image.
RUN sed -i 's/\r$//' /opt/rfp/entrypoint.sh \
 && chmod 755 /opt/rfp/entrypoint.sh \
 && cd /opt/rfp/pipeline && node build.js \
 && node /opt/rfp/init.js check \
 && chown -R node:node /opt/rfp
USER node

ENTRYPOINT ["tini", "--", "/opt/rfp/entrypoint.sh"]
