# Mesma versão do Bun usada no desenvolvimento local.
FROM oven/bun:1.3.11-alpine

WORKDIR /app

# Dependências primeiro, para o cache da camada sobreviver a mudanças de código.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# O tsconfig vai junto: o Bun lê dele as flags de decorators ao transpilar.
COPY tsconfig.json bunfig.toml ./
COPY src ./src

USER bun
EXPOSE 3000

# Roda direto do fonte, sem bundle (os requires opcionais do Nest quebram o bundler).
# Forma exec: o Bun é o PID 1 e recebe o SIGTERM do `docker stop`.
CMD ["bun", "src/main.ts"]
