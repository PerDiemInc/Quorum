FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ENV NODE_ENV=production QUORUM_HOST=0.0.0.0 QUORUM_DATA=/data QUORUM_WORKSPACE=/data/workspace
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node skills ./skills
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 4710
CMD ["node", "src/server.ts"]
