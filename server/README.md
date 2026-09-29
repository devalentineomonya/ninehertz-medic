# NineHertz NestJS Server with TypeORM & Docker

![NestJS Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/server/@nestjs/core?color=red&logo=nestjs)
![Node.js Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/server/engines/node?color=green&logo=node.js)
![TypeScript Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/server/dev/typescript?color=blue&logo=typescript)
![TypeORM Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/server/typeorm?color=informational)
![Docker](https://img.shields.io/badge/Docker-✓-blue?logo=docker)
![PNPM](https://img.shields.io/badge/pnpm-✓-orange?logo=pnpm)
![License](https://img.shields.io/github/license/devalentineomonya/ninehertz-medic?color=blue)

## Overview

This NestJS server provides a robust backend API for the NineHertz full-stack application. It features a modern architecture with TypeORM for database operations, Docker for containerization, and JWT authentication. Designed for rapid development and easy deployment.

## Project Structure

```bash
server/
├── src/
│   ├── auth/             # Authentication module
│   ├── common/           # Shared utilities and decorators
│   ├── config/           # Configuration setup
│   ├── entities/         # TypeORM entity definitions
│   ├── modules/          # Feature modules
│   ├── app.controller.ts
│   ├── app.module.ts
│   └── main.ts
├── docker/               # Docker configuration files
├── .env.example          # Environment variables template
├── docker-compose.yml    # Docker compose configuration
├── nest-cli.json         # NestJS configuration
├── package.json          # Dependencies and scripts
└── tsconfig.json         # TypeScript configuration
```

## Key Features

- 🐳 **Docker Integration** - Containerized development and deployment
- 🛡️ **JWT Authentication** - Secure token-based authentication
- 🗄️ **TypeORM** - Powerful ORM with PostgreSQL support
- 📝 **DTO Validation** - Robust input validation using class-validator
- 🧩 **Modular Architecture** - Clean separation of concerns
- 🔌 **Environment Configuration** - Easy management of environment variables
- 📊 **Swagger Documentation** - Auto-generated API documentation
- 🚦 **Error Handling** - Custom exception filters and interceptors

## Prerequisites

- Node.js v18+
- Docker & Docker Compose
- PNPM (recommended)

## Getting Started

### 1. Clone the repository:

```bash
git clone https://github.com/devalentineomonya/ninehertz-medic.git
cd ninehertz-medic/server
```

### 2. Install dependencies:

```bash
pnpm install
```

### 3. Configure environment:

```bash
cp .env.example .env
```

Edit the `.env` file with your configuration values.

### 4. Start Docker containers:

```bash
docker-compose up -d
```

### 5. Run database migrations:

```bash
pnpm typeorm migration:run
```

### 6. Start the server:

```bash
pnpm start:dev
```

## Development Workflow

**Start all services:**

```bash
docker-compose up -d
pnpm start:dev
```

**Run database migrations:**

```bash
pnpm typeorm migration:run
```

**Generate new migration:**

```bash
pnpm typeorm migration:generate src/migrations/<MigrationName>
```

**Access database container:**

```bash
docker exec -it ninehertz-db psql -U postgres
```

## API Documentation

After starting the server, access the Swagger UI at:

```
http://localhost:3000/api
```

## Docker Management

**Start containers:**

```bash
docker-compose up -d
```

**Stop containers:**

```bash
docker-compose down
```

**View logs:**

```bash
docker-compose logs -f
```

**Rebuild containers:**

```bash
docker-compose up -d --build
```

## Environment Variables

| Variable          | Description                  | Default Value                           |
| ----------------- | ---------------------------- | --------------------------------------- |
| PORT              | Server port                  | 3000                                    |
| DB_HOST           | Database host                | localhost                               |
| DB_PORT           | Database port                | 5432                                    |
| DB_USERNAME       | Database user                | postgres                                |
| DB_PASSWORD       | Database password            | postgres                                |
| DB_NAME           | Database name                | ninehertz                               |
| JWT_SECRET        | JWT signing secret           | -                                       |
| JWT_EXPIRES_IN    | Token expiration time        | 1h                                      |
| **BREVO_API_KEY** | **Brevo API key for emails** | **-**                                   |
| **MAIL_USER**     | **Sender email address**     | **your-email@example.com**              |
| MAIL_SENDER_NAME  | Sender display name          | NineHertz Medic - Your Health Our Pride |

### Email Configuration (Brevo)

This application uses **Brevo** (formerly Sendinblue) for transactional email delivery. To configure email functionality:

1. **Create a Brevo account:**
   - Sign up at [https://www.brevo.com](https://www.brevo.com)
   - Navigate to SMTP & API → API Keys
   - Create a new API key

2. **Configure environment variables:**

   ```bash
   BREVO_API_KEY=your_brevo_api_key_here
   MAIL_USER=your-verified-sender-email@example.com
   MAIL_SENDER_NAME="NineHertz Medic - Your Health Our Pride"
   ```

3. **Verify your sender domain/email:**
   - In Brevo dashboard, go to Senders & IPs → Senders
   - Add and verify your sender email address
   - This is required to send emails

4. **Testing email functionality:**

   ```bash
   # Run unit tests
   pnpm test -- mail.service.spec.ts

   # Run E2E tests (requires .env.test configuration)
   pnpm test:e2e -- mail.e2e-spec.ts
   ```

**Note:** The previous `nodemailer` implementation has been replaced with Brevo SDK for improved deliverability, better error handling, and enterprise-grade email infrastructure.

## Production Deployment

### Build Docker image:

```bash
docker build -t ninehertz-server .
```

### Run container:

```bash
docker run -d --name ninehertz-app \
  -p 3000:3000 \
  --env-file .env \
  ninehertz-server
```

### Docker Compose (production):

```bash
docker-compose -f docker-compose.prod.yml up -d
```

## TypeORM Configuration

TypeORM is configured in `src/config/typeorm.config.ts`. Key settings:

```typescript
export default registerAs('database', () => ({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  synchronize: false, // Always false in production!
  logging: process.env.NODE_ENV === 'development',
}));
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/your-feature`)
3. Commit changes (`git commit -am 'Add some feature'`)
4. Push to branch (`git push origin feature/your-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/devalentineomonya/ninehertz-medic/blob/main/LICENSE) file for details.

## Support

For issues or questions, please [open an issue](https://github.com/devalentineomonya/ninehertz-medic/issues) on GitHub.
