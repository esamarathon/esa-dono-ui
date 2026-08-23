# Local Development

## Setup

```bash
# Clone and install
git clone https://github.com/Codescales/esa-dono-ui.git
cd esa-dono-ui
npm install

# Set up environment
cp .env.example .env
# Edit .env with your Tiltify credentials and other values

# Initialize the database
cd server && npx prisma migrate dev --name init && npx prisma generate && cd ..

# Start (server on :3001, client on :5173)
npm run dev
```

## Running Tests

```bash
npm test                    # all workspace tests
npm run test --workspace server   # server only
npm run test --workspace client   # client only
npm run test:ci             # CI mode (junit reporter)
```
