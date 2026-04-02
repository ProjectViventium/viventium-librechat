# Changelog

All notable changes to LibreCodeInterpreter will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Container hardening with host information masking to prevent information leakage
- Optional WAN-only network access mode for containers with private IP blocking
- Hour and day periods for execution heatmap visualizations
- MyPy type checking integration with comprehensive type hints
- Dynamic Content Security Policy headers based on request path

### Changed
- Improved heatmap UI styling for better visualization
- Enhanced development environment with source directory mounting in docker-compose
- Updated Pydantic settings configuration for better type safety

### Removed
- Deprecated baseline performance documentation files
- Legacy deployment scripts

## [0.1.0] - 2024-12-XX

### Added

#### Core Features
- Multi-language code execution supporting 12 languages: Python, JavaScript, TypeScript, Go, Java, C, C++, PHP, Rust, R, Fortran, and D
- FastAPI-based REST API with interactive documentation
- Docker-based sandboxed execution environments with comprehensive security controls
- Redis-based session management with automatic cleanup
- MinIO/S3-compatible storage integration for persistent file storage

#### Performance Features
- REPL mode for Python with pre-warmed interpreter achieving 20-40ms execution latency
- Container pooling system with pre-warmed containers for ~3ms acquisition time
- Per-language container pool sizing for optimized resource allocation
- Thread-safe execution supporting 10+ concurrent requests
- State persistence for Python sessions with Redis and MinIO archival

#### Security Features
- API key-based authentication with rate limiting
- Network isolation with `network_mode: none` by default
- Read-only filesystem in containers
- All Linux capabilities dropped (`cap_drop: ALL`)
- Tmpfs mounts with `noexec,nosuid` flags
- No-new-privileges security option
- Resource limits for CPU, memory, and execution time
- Input validation and sanitization

#### File Management
- File upload and download with session isolation
- Unicode filename support
- Automatic cleanup of orphaned storage objects
- File listing and deletion per session

#### Monitoring & Observability
- SQLite-based metrics storage with historical tracking
- Admin dashboard API for system analytics and monitoring
- Execution metrics (latency, success rates, language usage)
- API metrics (request counts, error rates, endpoint usage)
- Comprehensive health check endpoints for Redis, MinIO, and Docker
- Detailed health status reporting
- Structured JSON logging with configurable levels
- Request/response logging middleware

#### API Key Management
- CLI tool for API key creation, listing, and deletion
- Rate limit configuration per API key
- Web UI for API key management
- Key rotation and lifecycle management

#### Testing & Quality
- Comprehensive load testing framework with multiple scenarios
- Integration test suite with container lifecycle testing
- Metrics collection and reporting for load tests
- CI/CD workflows for automated testing and building
- Docker image publishing workflow with multi-architecture support

#### Documentation
- Comprehensive architecture documentation
- Configuration guide with all environment variables
- Development setup instructions
- Testing guide with coverage reporting
- State persistence implementation details
- REPL mode documentation
- Performance optimization guide
- Security best practices
- API key management guide
- Metrics collection documentation

#### Developer Experience
- HTTPS/SSL support with automatic HTTP redirection
- CORS configuration for web clients
- Parallel Docker image building with BuildKit
- Environment-specific configuration with .env support
- Hot reload in development mode

### Changed
- Refactored execution service for better modularity
- Updated Docker build process with parallel builds
- Enhanced R execution environment with additional graphics libraries
- Improved state archival with better logging and error handling
- Consolidated documentation from README to dedicated files

### Fixed
- Container naming convention for better tracking
- Execution time limit handling
- State persistence edge cases

### Security
- Implemented comprehensive container hardening
- Added input validation across all endpoints
- Enforced resource limits to prevent DoS attacks
- Secured file upload/download with session validation

[unreleased]: https://github.com/LibreCodeInterpreter/LibreCodeInterpreter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LibreCodeInterpreter/LibreCodeInterpreter/releases/tag/v0.1.0
