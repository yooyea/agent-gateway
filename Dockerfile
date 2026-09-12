FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm install && npm run build
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
ENV PORT=8787
EXPOSE 8787
CMD ["node","apps/server/dist/index.js"]
