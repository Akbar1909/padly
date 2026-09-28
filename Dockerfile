# One image for both the web app and the worker (different commands).
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CHECKPOINT_DISABLE=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/build ./build
# The worker runs from source with tsx and shares app/lib with the web app.
COPY tsconfig.json ./
COPY app ./app
COPY worker ./worker
USER node
EXPOSE 3000
# Web: runs migrations then serves. Worker: `npm run worker` (see docker-compose.yml).
CMD ["npm", "run", "docker-start"]
