import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

/// Service for managing the SQLite database.
class DatabaseService {
  static Database? _database;
  static const _dbName = 'iris_chat.db';
  static const _dbVersion = 2;

  /// Get the database instance, initializing if necessary.
  Future<Database> get database async {
    _database ??= await _initDatabase();
    return _database!;
  }

  Future<Database> _initDatabase() async {
    final documentsDirectory = await getApplicationDocumentsDirectory();
    final path = join(documentsDirectory.path, _dbName);

    return openDatabase(
      path,
      version: _dbVersion,
      onCreate: _onCreate,
      onUpgrade: _onUpgrade,
    );
  }

  Future<void> _onCreate(Database db, int version) async {
    // Sessions table
    await db.execute('''
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        recipient_pubkey_hex TEXT NOT NULL,
        recipient_name TEXT,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER,
        last_message_preview TEXT,
        unread_count INTEGER DEFAULT 0,
        invite_id TEXT,
        is_initiator INTEGER DEFAULT 0,
        serialized_state TEXT
      )
    ''');

    // Messages table
    await db.execute('''
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        event_id TEXT,
        reply_to_id TEXT,
        reactions TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
      )
    ''');

    // Invites table
    await db.execute('''
      CREATE TABLE invites (
        id TEXT PRIMARY KEY,
        inviter_pubkey_hex TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        max_uses INTEGER,
        use_count INTEGER DEFAULT 0,
        accepted_by TEXT,
        serialized_state TEXT
      )
    ''');

    // Create indexes
    await db.execute(
        'CREATE INDEX idx_messages_session_id ON messages (session_id)');
    await db.execute(
        'CREATE INDEX idx_messages_timestamp ON messages (timestamp DESC)');
    await db.execute(
        'CREATE INDEX idx_sessions_last_message ON sessions (last_message_at DESC)');
  }

  Future<void> _onUpgrade(Database db, int oldVersion, int newVersion) async {
    if (oldVersion < 2) {
      // Add reactions column to messages table
      await db.execute('ALTER TABLE messages ADD COLUMN reactions TEXT');
    }
  }

  /// Close the database connection.
  Future<void> close() async {
    final db = _database;
    if (db != null) {
      await db.close();
      _database = null;
    }
  }

  /// Delete the database (for testing or reset).
  Future<void> deleteDatabase() async {
    final documentsDirectory = await getApplicationDocumentsDirectory();
    final path = join(documentsDirectory.path, _dbName);
    await databaseFactory.deleteDatabase(path);
    _database = null;
  }
}
