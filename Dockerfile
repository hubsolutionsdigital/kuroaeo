FROM node:22-alpine
WORKDIR /app
# Railway: attach a volume at /data in the service settings so the database survives redeploys.
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
