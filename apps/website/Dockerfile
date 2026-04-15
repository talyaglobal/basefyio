FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci

COPY . .

ARG PUBLIC_SITE_URL=https://kolaybase.com
ENV PUBLIC_SITE_URL=${PUBLIC_SITE_URL}
ARG PUBLIC_APP_URL=https://app.kolaybase.com
ENV PUBLIC_APP_URL=${PUBLIC_APP_URL}
ARG PUBLIC_PLATFORM_API_URL=https://api.kolaybase.com
ENV PUBLIC_PLATFORM_API_URL=${PUBLIC_PLATFORM_API_URL}

RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
