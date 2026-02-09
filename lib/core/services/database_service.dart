import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

/// Service for managing the SQLite database.
class DatabaseService {
  DatabaseService({String? dbPath}) : _dbPathOverride = dbPath;

  Database? _database;
  Future<Database>? _databaseFuture;
  final String? _dbPathOverride;

  static const _dbName = 'iris_chat.db';
  static const _dbVersion = 6;

  /// Get the database instance, initializing if necessary.
  Future<Database> get database {
    final existing = _database;
    if (existing != null) return Future.value(existing);

    // Avoid opening multiple concurrent connections. This can lead to
    // "database locked" warnings (especially during schema creation/upgrades).
    return _databaseFuture ??= _initDatabase()
        .then((db) {
          _database = db;
          return db;
        })
        .catchError((Object e, StackTrace st) {
          _databaseFuture = null;
          Error.throwWithStackTrace(e, st);
        });
  }

  Future<Database> _initDatabase() async {
    final path = _dbPathOverride ?? await _defaultDbPath();

    return openDatabase(
      path,
      version: _dbVersion,
      onConfigure: (db) async {
        // Best-effort pragmas to reduce locking and keep referential integrity.
        // Ignore errors to avoid hard-failing app startup on older SQLite builds.
        try {
          await db.execute('PRAGMA foreign_keys = ON');
        } catch (_) {}
        try {
          await db.execute('PRAGMA journal_mode = WAL');
        } catch (_) {}
        try {
          await db.execute('PRAGMA busy_timeout = 5000');
        } catch (_) {}
      },
      onCreate: _onCreate,
      onUpgrade: _onUpgrade,
    );
  }

  Future<String> _defaultDbPath() async {
    final documentsDirectory = await getApplicationDocumentsDirectory();
    return join(documentsDirectory.path, _dbName);
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
        serialized_state TEXT,
        message_ttl_seconds INTEGER
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
        rumor_id TEXT,
        reply_to_id TEXT,
        reactions TEXT,
        expires_at INTEGER,
        sender_pubkey_hex TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
      )
    ''');

    // Groups table (private group chats coordinated via encrypted group-tagged rumors)
    await db.execute('''
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        picture TEXT,
        members TEXT NOT NULL,
        admins TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        secret TEXT,
        accepted INTEGER DEFAULT 0,
        last_message_at INTEGER,
        last_message_preview TEXT,
        unread_count INTEGER DEFAULT 0
      )
    ''');

    // Group messages table.
    await db.execute('''
      CREATE TABLE group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        event_id TEXT,
        rumor_id TEXT,
        reply_to_id TEXT,
        reactions TEXT,
        expires_at INTEGER,
        sender_pubkey_hex TEXT,
        FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE
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
      'CREATE INDEX idx_messages_session_id ON messages (session_id)',
    );
    await db.execute(
      'CREATE INDEX idx_messages_timestamp ON messages (timestamp DESC)',
    );
    await db.execute(
      'CREATE INDEX idx_messages_rumor_id ON messages (rumor_id)',
    );
    await db.execute(
      'CREATE INDEX idx_messages_expires_at ON messages (expires_at)',
    );
    await db.execute(
      'CREATE INDEX idx_sessions_last_message ON sessions (last_message_at DESC)',
    );
    await db.execute(
      'CREATE INDEX idx_groups_last_message ON groups (last_message_at DESC)',
    );
    await db.execute(
      'CREATE INDEX idx_group_messages_group_id ON group_messages (group_id)',
    );
    await db.execute(
      'CREATE INDEX idx_group_messages_timestamp ON group_messages (timestamp DESC)',
    );
    await db.execute(
      'CREATE INDEX idx_group_messages_rumor_id ON group_messages (rumor_id)',
    );
    await db.execute(
      'CREATE INDEX idx_group_messages_expires_at ON group_messages (expires_at)',
    );
  }

  Future<void> _onUpgrade(Database db, int oldVersion, int newVersion) async {
    if (oldVersion < 2) {
      // Add reactions column to messages table
      await db.execute('ALTER TABLE messages ADD COLUMN reactions TEXT');
    }
    if (oldVersion < 3) {
      // Add stable inner (rumor) id column for receipts and multi-device support.
      await db.execute('ALTER TABLE messages ADD COLUMN rumor_id TEXT');
      await db.execute(
        'CREATE INDEX idx_messages_rumor_id ON messages (rumor_id)',
      );
    }
    if (oldVersion < 4) {
      // Add sender pubkey column for group messages.
      await db.execute(
        'ALTER TABLE messages ADD COLUMN sender_pubkey_hex TEXT',
      );

      // Add groups table.
      await db.execute('''
        CREATE TABLE groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          picture TEXT,
          members TEXT NOT NULL,
          admins TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          secret TEXT,
          accepted INTEGER DEFAULT 0,
          last_message_at INTEGER,
          last_message_preview TEXT,
          unread_count INTEGER DEFAULT 0
        )
      ''');
      await db.execute(
        'CREATE INDEX idx_groups_last_message ON groups (last_message_at DESC)',
      );
    }
    if (oldVersion < 5) {
      await db.execute('''
        CREATE TABLE group_messages (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          direction TEXT NOT NULL,
          status TEXT NOT NULL,
          event_id TEXT,
          rumor_id TEXT,
          reply_to_id TEXT,
          reactions TEXT,
          sender_pubkey_hex TEXT,
          FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE
        )
      ''');
      await db.execute(
        'CREATE INDEX idx_group_messages_group_id ON group_messages (group_id)',
      );
      await db.execute(
        'CREATE INDEX idx_group_messages_timestamp ON group_messages (timestamp DESC)',
      );
      await db.execute(
        'CREATE INDEX idx_group_messages_rumor_id ON group_messages (rumor_id)',
      );
    }
    if (oldVersion < 6) {
      await db.execute(
        'ALTER TABLE sessions ADD COLUMN message_ttl_seconds INTEGER',
      );
      await db.execute('ALTER TABLE messages ADD COLUMN expires_at INTEGER');
      await db.execute(
        'CREATE INDEX idx_messages_expires_at ON messages (expires_at)',
      );
      await db.execute(
        'ALTER TABLE group_messages ADD COLUMN expires_at INTEGER',
      );
      await db.execute(
        'CREATE INDEX idx_group_messages_expires_at ON group_messages (expires_at)',
      );
    }
  }

  /// Close the database connection.
  Future<void> close() async {
    final db = _database;
    final future = _databaseFuture;
    _database = null;
    _databaseFuture = null;

    if (db != null) {
      await db.close();
      return;
    }

    // If an open is in-flight, wait and close best-effort.
    if (future != null) {
      try {
        final opened = await future;
        await opened.close();
      } catch (_) {}
    }
  }

  /// Delete the database (for testing or reset).
  Future<void> deleteDatabase() async {
    await close();
    final path = _dbPathOverride ?? await _defaultDbPath();
    await databaseFactory.deleteDatabase(path);
  }
}
