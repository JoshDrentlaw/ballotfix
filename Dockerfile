FROM denoland/deno:alpine
WORKDIR /app

COPY . .

# No native deps (unlike parallax-fix's local embedder), so the default
# Deno npm cache is enough — no --node-modules-dir needed.
RUN deno cache src/serve.ts src/main.ts

EXPOSE 8787

# deno.jsonc's `serve` task is the single source of truth for the permission
# grant (SECURITY.md); HOST/PORT below come from docker-compose's environment,
# not a .env file (none is baked into the image).
CMD ["deno", "task", "serve"]
