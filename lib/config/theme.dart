import 'package:flutter/material.dart';

class AppTheme {
  // Iris brand colors
  static const _primaryPurple = Color(0xFF7A29FF);
  static const _deepPurple = Color(0xFF3C21C8);
  static const _darkBackground = Color(0xFF0D0D0D);
  static const _darkSurface = Color(0xFF1A1A1A);
  static const _darkSurfaceVariant = Color(0xFF252525);

  static ThemeData get light => ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _primaryPurple,
          brightness: Brightness.light,
        ),
        fontFamily: 'Inter',
      );

  static ThemeData get dark => ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: const ColorScheme.dark(
          primary: _primaryPurple,
          secondary: _deepPurple,
          surface: _darkSurface,
          surfaceContainerHighest: _darkSurfaceVariant,
          onPrimary: Colors.white,
          onSecondary: Colors.white,
          onSurface: Colors.white,
        ),
        scaffoldBackgroundColor: _darkBackground,
        appBarTheme: const AppBarTheme(
          backgroundColor: _darkBackground,
          foregroundColor: Colors.white,
          elevation: 0,
        ),
        cardTheme: const CardThemeData(
          color: _darkSurface,
        ),
        fontFamily: 'Inter',
      );
}
