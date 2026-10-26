FROM node:22-alpine
WORKDIR /app
RUN npm install --omit=dev pg@8 && npm cache clean --force
COPY prober.mjs ./
USER node
CMD ["node", "prober.mjs"]
