# Knowmind — das Agentengehirn aus Deutschland (https://knowmind.de)
# Stdio-MCP-Server als Container. Ohne KNOWMIND_TOKEN läuft der Server im
# Discovery-Modus (initialize/tools/list über die öffentliche Server-Discovery);
# tools/call erfordert einen Token (`knowmind login` bzw. ENV KNOWMIND_TOKEN).
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY src ./src
COPY README.md CHANGELOG.md LICENSE ./

# Optional: KNOWMIND_TOKEN (kmt_…) und KNOWMIND_API_URL per ENV setzen.
ENTRYPOINT ["node", "bin/knowmind.js", "mcp"]
