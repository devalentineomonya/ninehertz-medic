# NineHertz React Client with TanStack Query & Vite

![React Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/client/react?color=61dafb&logo=react)
![TypeScript Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/client/dev/typescript?color=3178c6&logo=typescript)
![Vite Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/client/vite?color=646cff&logo=vite)
![TanStack Query Version](https://img.shields.io/github/package-json/dependency-version/devalentineomonya/ninehertz-medic/client/@tanstack/react-query?color=ff4154)
![PNPM](https://img.shields.io/badge/pnpm-✓-orange?logo=pnpm)
![License](https://img.shields.io/github/license/devalentineomonya/ninehertz-medic?color=blue)

## Overview

This React client application is part of the NineHertz Full-Stack Starter project, providing a modern frontend interface built with React, TypeScript, and TanStack Query. It connects to the NestJS backend and features responsive design, state management, and authentication flows.

**Live Demo**: [https://nine-hertz-demo.com](https://nine-hertz-demo.com) (example)

## Project Structure

```bash
client/
├── public/              # Static assets
├── src/
│   ├── api/             # API service layer
│   ├── assets/          # Images, fonts, etc.
│   ├── components/      # Reusable UI components
│   ├── context/         # React context providers
│   ├── hooks/           # Custom React hooks
│   ├── layouts/         # Page layout components
│   ├── pages/           # Application pages
│   ├── styles/          # Global styles and Tailwind config
│   ├── types/           # TypeScript type definitions
│   ├── utils/           # Utility functions
│   ├── App.tsx          # Main application component
│   ├── main.tsx         # Application entry point
│   └── vite-env.d.ts    # Vite type declarations
├── .eslintrc.json       # ESLint configuration
├── .prettierrc          # Prettier configuration
├── index.html           # Main HTML template
├── package.json         # Dependencies and scripts
├── tailwind.config.js   # Tailwind CSS configuration
├── tsconfig.json        # TypeScript configuration
└── vite.config.ts       # Vite build configuration
```

## Key Features

- ⚡ **Vite-powered** - Blazing fast development experience
- 🧩 **Component Library** - Reusable UI components with Tailwind CSS
- 🔄 **TanStack Query** - Powerful data fetching and state management
- 🔐 **Authentication Flow** - JWT-based login/registration system
- 📱 **Fully Responsive** - Mobile-first responsive design
- 📦 **Modular Architecture** - Well-organized feature-based structure
- 🛡️ **Type Safety** - TypeScript throughout the application
- 💅 **Tailwind CSS** - Utility-first styling framework
- ⚙️ **ESLint + Prettier** - Code quality and formatting

## Prerequisites

- Node.js v18+
- PNPM (recommended) or npm
- Backend server running (see [server README](https://github.com/devalentineomonya/ninehertz-medic/tree/main/server))

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/devalentineomonya/ninehertz-medic.git
   cd ninehertz-medic/client
   ```

2. Install dependencies:
   ```bash
   pnpm install
   # or
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env.local
   ```
   Update the `.env.local` file with your backend API URL:
   ```env
   VITE_API_BASE_URL=http://localhost:3000
   ```

## Running the Application

**Development mode:**
```bash
pnpm dev
# or
npm run dev
```

**Production build:**
```bash
pnpm build
pnpm preview
```

## Key Technologies Used

| Technology       | Purpose                           |
|------------------|-----------------------------------|
| React 18         | Component-based UI library        |
| TypeScript       | Static type checking              |
| Vite             | Build tool and development server |
| TanStack Query   | Data fetching and state management|
| React Router     | Client-side routing               |
| Tailwind CSS     | Utility-first CSS framework       |
| Axios            | HTTP client for API requests      |
| React Hook Form  | Form management and validation    |
| Zod              | Schema validation                 |
| ESLint           | Code linting                      |
| Prettier         | Code formatting                   |

## Application Structure Highlights

### 1. API Service Layer (`src/api`)
```tsx
// api/auth.ts
import axios from 'axios';

export const login = async (credentials: LoginDto) => {
  const response = await axios.post('/auth/login', credentials);
  return response.data;
};

export const register = async (userData: RegisterDto) => {
  const response = await axios.post('/auth/register', userData);
  return response.data;
};
```

### 2. TanStack Query Integration (`src/App.tsx`)
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Application components */}
    </QueryClientProvider>
  );
}
```

### 3. Protected Route Component (`src/components/ProtectedRoute.tsx`)
```tsx
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
  const { isAuthenticated } = useAuth();
  
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
};
```

### 4. Responsive Layout (`src/layouts/MainLayout.tsx`)
```tsx
import { Outlet } from 'react-router-dom';
import { Header, Footer, Sidebar } from '../components';

const MainLayout = () => {
  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      
      <div className="flex flex-1">
        <Sidebar />
        
        <main className="flex-1 p-4 md:p-6 bg-gray-50">
          <Outlet />
        </main>
      </div>
      
      <Footer />
    </div>
  );
};
```

## Environment Variables

| Variable              | Description                     | Default Value              |
|-----------------------|--------------------------------|----------------------------|
| VITE_API_BASE_URL    | Base URL for API requests      | http://localhost:3000     |
| VITE_APP_NAME        | Application display name       | NineHertz App             |
| VITE_DEFAULT_THEME   | Default color theme            | light                     |

## Deployment

The client is ready for deployment to various platforms:

### Vercel
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdevalentineomonya%2Fninehertz-medic&project-name=ninehertz-app&repository-name=ninehertz-app)

### Netlify
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/devalentineomonya/ninehertz-medic)

### Static Hosting
1. Build the production bundle:
   ```bash
   pnpm build
   ```
2. Deploy the `dist` folder to any static hosting service

## Development Workflow

1. Start the development server:
   ```bash
   pnpm dev
   ```

2. Implement features using a component-driven approach:
   - Create new components in `src/components`
   - Add new pages in `src/pages`
   - Create API services in `src/api`

3. Format code before committing:
   ```bash
   pnpm format
   ```

4. Lint code to check for issues:
   ```bash
   pnpm lint
   ```

## Contributing

Contributions are welcome! Please follow these guidelines:
1. Fork the repository
2. Create a new feature branch
3. Commit your changes with descriptive messages
4. Push to your fork
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/devalentineomonya/ninehertz-medic/blob/main/LICENSE) file for details.

## Support

For issues or feature requests, please [open an issue](https://github.com/devalentineomonya/ninehertz-medic/issues) on GitHub.

---

**Project Maintainer**: [Valentine Omonya](https://github.com/devalentineomonya)  
**Project Status**: Active Development (July 2024)
