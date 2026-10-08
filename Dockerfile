# Ponte Neppo (ex-Lara · Prospecções) — Node puro, sem dependências.
# Desde 07/10/2026 a Lara do Google Maps mora no portal Lara (Railway). Aqui só roda a ponte
# que fala com a Neppo, porque a Neppo só responde a IP do BRASIL (Fly, região gru).
FROM node:20-slim
WORKDIR /app
COPY ponte.js package.json /app/
# o volume /data guarda o histórico da Lara antiga (lido por GET /legado)
ENV DATA_DIR=/data
ENV NEPPO_STRICT_TLS=0
EXPOSE 8080
CMD ["node", "ponte.js"]
