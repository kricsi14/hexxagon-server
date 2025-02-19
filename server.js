// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIo = require('socket.io');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// Global objects to track lobby and players.
let lobby = []; // Array of { id, username }
let players = {}; // Map socket.id -> { username, inMatch, currentMatch }

// A basic Game class (using our previous logic) to manage each match.
class Game {
    constructor() {
        this.hexRadius = 30;
        this.resetGame();
    }

    resetGame() {
        this.board = [];
        this.currentPlayer = 'player1';
        this.gameOver = false;
        this.winner = null;
        this.initBoard();
    }

    initBoard() {
        const N = 4;
        let idCounter = 0;
        const boardCells = [];
        for (let q = -N; q <= N; q++) {
            const rMin = Math.max(-N, -q - N);
            const rMax = Math.min(N, -q + N);
            for (let r = rMin; r <= rMax; r++) {
                boardCells.push({
                    id: idCounter++,
                    q,
                    r,
                    player: null,
                });
            }
        }
        // Define starting positions for each player.
        const player1Positions = [
            { q: -4, r: 0 },
            { q: 4, r: -4 },
            { q: 0, r: 4 }
        ];
        const player2Positions = [
            { q: 4, r: 0 },
            { q: -4, r: 4 },
            { q: 0, r: -4 }

        ];


        // Set initial pieces for Player 1.
        player1Positions.forEach(pos => {
            const cell = boardCells.find(cell => cell.q === pos.q && cell.r === pos.r);
            if (cell) cell.player = 'player1';
        });

        // Set initial pieces for Player 2.
        player2Positions.forEach(pos => {
            const cell = boardCells.find(cell => cell.q === pos.q && cell.r === pos.r);
            if (cell) cell.player = 'player2';
        });

        this.board = boardCells;
    }

    getValidMoves(fromCell) {
        return this.board.filter(cell => {
            if (cell.player !== null) return false;
            const distance = this.hexDistance(fromCell, cell);
            return distance === 1 || distance === 2;
        });
    }

    hexDistance(a, b) {
        const dq = a.q - b.q;
        const dr = a.r - b.r;
        return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
    }

    capture(targetCell, player) {
        this.board.forEach(cell => {
            if (cell.player && cell.player !== player) {
                if (this.hexDistance(targetCell, cell) === 1) {
                    cell.player = player;
                }
            }
        });
    }

    makeMove(fromCellId, targetCellId, player) {
        if (this.gameOver) {
            return { success: false, message: 'Game over' };
        }
        const fromCell = this.board.find(cell => cell.id === fromCellId);
        const targetCell = this.board.find(cell => cell.id === targetCellId);
        if (!fromCell || !targetCell) {
            return { success: false, message: 'Invalid cells' };
        }
        if (fromCell.player !== player) {
            return { success: false, message: 'Not your piece' };
        }
        const distance = this.hexDistance(fromCell, targetCell);
        if (targetCell.player !== null || (distance !== 1 && distance !== 2)) {
            return { success: false, message: 'Invalid move' };
        }
        if (distance === 2) {
            fromCell.player = null;
        }
        targetCell.player = player;
        this.capture(targetCell, player);
        this.currentPlayer = player === 'player1' ? 'player2' : 'player1';
        this.checkGameOver();
        return { success: true, gameState: this.getState() };
    }

    checkGameOver() {
        let movesAvailable = false;
        this.board.forEach(cell => {
            if (cell.player === this.currentPlayer) {
                if (this.getValidMoves(cell).length > 0) {
                    movesAvailable = true;
                }
            }
        });
        if (!movesAvailable) {
            this.gameOver = true;
            const countP1 = this.board.filter(cell => cell.player === 'player1').length;
            const countP2 = this.board.filter(cell => cell.player === 'player2').length;
            if (countP1 > countP2) {
                this.winner = 'player1';
            } else if (countP2 > countP1) {
                this.winner = 'player2';
            } else {
                this.winner = 'draw';
            }
        }
    }

    getState() {
        return {
            board: this.board,
            currentPlayer: this.currentPlayer,
            gameOver: this.gameOver,
            winner: this.winner,
            opponentLeft: this.opponentLeft
        };
    }
}

io.on('connection', (socket) => {
    console.log('Client connected: ' + socket.id);
    // Register the player.
    players[socket.id] = { username: null, inMatch: false, currentMatch: null };

    // --- LOBBY EVENTS ---
    socket.on('joinLobby', (data) => {
        // Set the player's username.
        players[socket.id].username = data.username;
        // Check if this socket id is already in the lobby.
        if (!lobby.find(p => p.id === socket.id)) {
            lobby.push({ id: socket.id, username: data.username });
        }
        io.emit('lobbyUpdate', lobby);
    });

    socket.on('challengePlayer', (data) => {
        const targetId = data.targetId;
        if (players[targetId]) {
            // Forward the challenge to the target.
            players[targetId].socket = io.sockets.sockets.get(targetId);
            players[targetId].socket.emit('challengeReceived', { challengerId: socket.id, challengerName: players[socket.id].username });
        }
    });

    socket.on('acceptChallenge', (data) => {
        console.log('acceptChallenge triggered for socket:', socket.id, 'with data:', data);
        const challengerId = data.challengerId;
        // Remove both from the lobby.
        lobby = lobby.filter(p => p.id !== socket.id && p.id !== challengerId);

        // Mark both as in-match.
        players[socket.id].inMatch = true;
        players[challengerId].inMatch = true;

        // Create a new game instance.
        const game = new Game();
        players[socket.id].currentMatch = game;
        players[challengerId].currentMatch = game;

        // Assign roles and store them.
        players[challengerId].role = 'player1';
        players[socket.id].role = 'player2';

        // Build a players mapping.
        const playersMapping = {
            player1: players[challengerId].username,
            player2: players[socket.id].username
        };

        // Build two game state objects with a 'yourRole' property.
        const challengerGameState = {
            ...game.getState(),
            players: playersMapping,
            yourRole: 'player1'
        };

        const otherGameState = {
            ...game.getState(),
            players: playersMapping,
            yourRole: 'player2'
        };

        console.log('Emitting matchStarted to challenger:', challengerGameState);
        console.log('Emitting matchStarted to opponent:', otherGameState);

        // Emit matchStarted individually.
        io.sockets.sockets.get(challengerId).emit('matchStarted', challengerGameState);
        socket.emit('matchStarted', otherGameState);
    });

    socket.on('declineChallenge', (data) => {
        const challengerId = data.challengerId;
        if (players[challengerId]) {
            io.sockets.sockets.get(challengerId).emit('challengeDeclined', { from: socket.id });
        }
    });

    // --- GAME EVENTS ---
    socket.on('makeMove', (data) => {
        const fromCellId = data.fromCellId;
        const targetCellId = data.targetCellId;
        // The client should also send its role ("player1" or "player2").
        const role = data.player;
        const currentGame = players[socket.id].currentMatch;
        if (!currentGame) {
            socket.emit('invalidMove', 'No active match');
            return;
        }
        const result = currentGame.makeMove(fromCellId, targetCellId, role);
        if (result.success) {
            // Broadcast updated state to both players in the match.
            Object.keys(players).forEach((socketId) => {
                if (players[socketId].currentMatch === currentGame) {
                    io.sockets.sockets.get(socketId).emit('gameState', currentGame.getState());
                }
            });
        } else {
            socket.emit('invalidMove', result.message);
        }
    });

    socket.on('surrender', () => {
        console.log('Surrender received from', socket.id);
        const currentGame = players[socket.id].currentMatch;
        if (currentGame && !currentGame.gameOver) {
            currentGame.gameOver = true;
            // Get the surrendering player's role.
            const surrenderingRole = players[socket.id].role;
            // Determine the winning role.
            const winningRole = surrenderingRole === 'player1' ? 'player2' : 'player1';
            // Find the opponent's username.
            let winningUsername = null;
            Object.keys(players).forEach((sockId) => {
                if (players[sockId].currentMatch === currentGame && sockId !== socket.id) {
                    winningUsername = players[sockId].username;
                }
            });
            currentGame.winner = winningUsername || winningRole;
            // Broadcast game state to both players still connected.
            Object.keys(players).forEach((sockId) => {
                if (players[sockId].currentMatch === currentGame) {
                    io.sockets.sockets.get(sockId).emit('gameState', currentGame.getState());
                }
            });
        }
    });

    socket.on('leaveGame', () => {
        console.log('Leave game received from', socket.id);
        if (players[socket.id].inMatch) {
            // Identify the current game and the opponent.
            const currentGame = players[socket.id].currentMatch;
            let opponentId = null;
            Object.keys(players).forEach((sockId) => {
                if (players[sockId].currentMatch === currentGame && sockId !== socket.id) {
                    opponentId = sockId;
                }
            });
            // Mark the match as over if it isn't already.
            if (currentGame && !currentGame.gameOver) {
                currentGame.gameOver = true;
                // Set a flag so the remaining player knows the opponent left.
                currentGame.opponentLeft = true;
                // Optionally, set the winner to the remaining player's username.
                let winningUsername = opponentId ? players[opponentId].username : 'opponent';
                currentGame.winner = winningUsername;
                if (opponentId) {
                    io.sockets.sockets.get(opponentId).emit('gameState', currentGame.getState());
                }
            }
            // Clear match data for the leaving player.
            players[socket.id].inMatch = false;
            players[socket.id].currentMatch = null;
            // Return the leaving player to the lobby.
            lobby.push({ id: socket.id, username: players[socket.id].username });
            io.emit('lobbyUpdate', lobby);
        }
    });

    socket.on('resetGame', () => {
        const currentGame = players[socket.id].currentMatch;
        if (currentGame) {
            currentGame.resetGame();
            Object.keys(players).forEach((socketId) => {
                if (players[socketId].currentMatch === currentGame) {
                    io.sockets.sockets.get(socketId).emit('gameState', currentGame.getState());
                }
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected: ' + socket.id);
        lobby = lobby.filter(p => p.id !== socket.id);
        delete players[socket.id];
        io.emit('lobbyUpdate', lobby);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
