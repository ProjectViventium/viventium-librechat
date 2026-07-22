# VIVENTIUM START — keep contributor tooling on the supported release runtime.
FROM node:24.16.0-bookworm
# VIVENTIUM END

RUN useradd -m -s /bin/bash vscode
RUN mkdir -p /workspaces && chown -R vscode:vscode /workspaces
WORKDIR /workspaces
