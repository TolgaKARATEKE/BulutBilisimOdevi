FROM nginx:1.25-alpine

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy template (nginx:alpine processes /etc/nginx/templates/*.template automatically)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Copy static files
COPY public/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/nginx-health || exit 1
