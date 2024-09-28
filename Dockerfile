FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY . /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile
RUN cd /temp/dev && bun build ./index.ts --compile --outfile icosagent

# # [optional] tests & build
# ENV NODE_ENV=production
# RUN bun run build

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/dev/icosagent icosagent

# run the app
USER bun
# EXPOSE 3000/tcp
ENTRYPOINT [ "./icosagent" ]
