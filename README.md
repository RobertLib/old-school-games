# 🕹️ Old School Games

A web application for browsing and playing classic MS-DOS games directly in your browser. The project offers a nostalgic experience with games from the MS-DOS era combined with a modern user interface.

## 🎮 Features

- **Game Catalog**: Browse through an extensive database of classic MS-DOS games
- **Browser Gaming**: Play games directly in your browser without any installation
- **Filtering & Search**:
  - Filter by genre, release year, developer, publisher
  - Alphabetical filtering by first letter
  - Text search by game title
- **Game Rating**: User rating system for games
- **Game of the Week**: Automatically selected weekly featured game
- **Favorite Games**: Save favorite games in localStorage
- **Recently Played**: History of recently played games
- **Comments**: Comment system for individual games
- **Administration**: Admin interface for managing games and content
- **Analytics**: Visitor tracking and statistics
- **Responsive Design**: Fully responsive web interface
- **Sitemap**: Automatic sitemap generation for SEO
- **IndexNow**: Automatic search engine notification for content changes

## 🛠️ Technologies

- **Backend**: Node.js, Express.js, TypeScript
- **Database**: PostgreSQL
- **Frontend**: EJS templates, vanilla JavaScript
- **Styling**: Custom CSS
- **Testing**: Vitest
- **Deployment**: Fly.io (Docker)
- **Session management**: express-session with PostgreSQL store
- **Security**: Helmet, rate limiting, CSRF protection

## 📁 Project Structure

```
├── index.ts              # Main server application
├── db.ts                 # Database connection
├── migrate.ts            # Migration script
├── models/               # Database models
│   ├── game.ts          # Game model
│   ├── user.ts          # User model
│   ├── comment.ts       # Comment model
│   ├── game-of-the-week.ts # Game of the week model
│   └── analytics.ts     # Analytics model
├── routes/               # API endpoints
│   ├── auth.ts          # Authentication
│   ├── games.ts         # Game management
│   ├── home.ts          # Home page
│   ├── comments.ts      # Comments
│   ├── indexnow.ts      # IndexNow integration
│   └── analytics.ts     # Analytics
├── utils/                # Utility functions
│   └── indexnow.ts      # IndexNow API client
├── views/                # EJS templates
├── public/               # Static files
├── middlewares/          # Express middlewares
├── validations/          # Validation logic
├── migrations/           # SQL migrations
└── tests/               # Tests
```

## 🚀 Installation & Setup

### Prerequisites

- Node.js 22+
- PostgreSQL
- npm or yarn

### Local Development

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd old-school-games
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Database setup**

   - Create a PostgreSQL database
   - Set the `DATABASE_URL` environment variable

   ```bash
   export DATABASE_URL="postgresql://username:password@localhost:5432/old_school_games"
   ```

4. **Run migrations**

   ```bash
   npm run migrate
   ```

5. **Start the application**

   ```bash
   # Development mode with hot reload
   npm run dev

   # Production mode
   npm start
   ```

The application will run on `http://localhost:3000`

## 📝 NPM Scripts

- `npm run dev` - Start in development mode with nodemon
- `npm start` - Start in production mode
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run migrate` - Run database migrations
- `npm run format:ejs` - Format EJS templates

## 🗄️ Database Models

### Games

- `title` - Game title
- `slug` - URL-friendly identifier
- `description` - Game description
- `genre` - Genre (enum)
- `release` - Release year
- `developer` - Developer
- `publisher` - Publisher
- `images` - Array of images
- `stream` - Game file (.zip)
- `manual` - Manual (.pdf)

### Users

- `email` - User email
- `password` - Hashed password
- `role` - Role (USER/ADMIN)

### Comments

- `nick` - Author nickname
- `content` - Comment content
- `gameId` - Reference to game

### Ratings

- `gameId` - Reference to game
- `ipAddress` - Rater's IP address
- `rating` - Rating 1-5

## 🔧 Configuration

The application uses the following environment variables:

- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret key for sessions
- `NODE_ENV` - Application environment (development/production)
- `INDEXNOW_KEY` - IndexNow API key for search engine notifications
- `SITE_URL` - Full URL of the website (e.g., https://yoursite.com)

### IndexNow Setup

1. Generate a random key:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Create key file in `public/` directory:

   ```bash
   echo "your-generated-key" > public/your-generated-key.txt
   ```

3. Add environment variables:
   ```env
   INDEXNOW_KEY="your-generated-key"
   SITE_URL="https://yoursite.com"
   ```

## 🧪 Testing

The project includes a comprehensive test suite with:

- Unit tests for models
- Integration tests for API endpoints
- Middleware tests
- Validation tests

```bash
# Run all tests
npm test

# Tests with coverage report
npm run test:coverage

# Watch mode for development
npm run test:watch
```

## 🚀 Deployment

The application is ready for deployment on Fly.io:

1. **Install Fly CLI**
2. **Deploy the application**
   ```bash
   fly deploy
   ```

Deployment configuration files:

- `Dockerfile` - Docker image definition
- `fly.toml` - Fly.io configuration

## 📊 Features

### For Visitors

- Browse game catalog
- Play games in browser
- Rate games
- Add comments
- Save favorite games
- Game play history

### For Administrators

- Add new games
- Edit existing games
- Manage comments
- View analytics

## 🤝 Contributing

1. Fork the project
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the ISC License.

## 🎯 Roadmap

- [ ] Support for multiple gaming platforms
- [ ] User profiles with achievements
- [ ] Multiplayer features
- [ ] Mobile application
- [ ] Third-party API
- [ ] Advanced filtering
- [ ] Social features
