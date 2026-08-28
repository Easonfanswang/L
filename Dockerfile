FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./

ENV NODE_ENV=production

ENV CHECK_INTERVAL=60000
ENV TIME_ZONE="Asia/Shanghai"

CMD ["npm", "start"]