FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy app source
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_ROOT=/data

EXPOSE 3000

CMD ["npm", "start"]
