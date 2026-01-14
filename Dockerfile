FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# Install ffmpeg for video composition
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

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
