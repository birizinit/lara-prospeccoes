# Lara · Prospecções — Node puro (sem dependências)
FROM node:20-slim
WORKDIR /app
COPY . /app
# estado e fila vão para o Volume (o FS do container é efêmero — ver server.js)
ENV DATA_DIR=/data
ENV NEPPO_STRICT_TLS=0
# no Fly a porta vem do fly.toml (PORT=8080 / internal_port=8080); o server usa process.env.PORT
EXPOSE 8080
CMD ["node", "server.js"]
