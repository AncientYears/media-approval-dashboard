# Stage 1: Build frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend
FROM node:22-alpine AS backend-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx tsc

# Stage 3: Production
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./public

RUN mkdir -p data

ENV NODE_ENV=production
ENV DATABASE_PATH=./data/app.db

EXPOSE 3000

CMD ["node", "dist/server.js"]
