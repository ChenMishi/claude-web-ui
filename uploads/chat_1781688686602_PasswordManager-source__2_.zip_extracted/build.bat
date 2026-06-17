@echo off
cd /d "%~dp0"
title Password Manager - Build

echo ============================================
echo   Password Manager - Windows Build Script
echo ============================================
echo.

:: Find Python 3
set PYEXE=
python --version >nul 2>&1 && set PYEXE=python
if defined PYEXE goto :found_python
python3 --version >nul 2>&1 && set PYEXE=python3
if defined PYEXE goto :found_python

echo [ERROR] Python 3 not found.
echo Please install from https://python.org
echo Make sure to check "Add Python to PATH"
pause
exit /b 1

:found_python
echo [1/3] Python found:
%PYEXE% --version
echo.

:: Install dependencies
echo [2/3] Installing dependencies...
%PYEXE% -m pip install cryptography pyinstaller pynput pystray Pillow --quiet
if errorlevel 1 (
    echo Retrying with verbose mode...
    %PYEXE% -m pip install cryptography pyinstaller pynput pystray Pillow
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
)
echo        Done.
echo.

:: Build exe
echo [3/3] Building PasswordManager.exe...
echo        This may take 1-2 minutes, please wait...
echo.

%PYEXE% -m PyInstaller --onefile --windowed --icon=icon.ico --add-data "icon.ico;." --name PasswordManager --clean --noconfirm --hidden-import tkinter --hidden-import tkinter.ttk --hidden-import tkinter.messagebox --hidden-import tkinter.filedialog --hidden-import cryptography --hidden-import cryptography.fernet --hidden-import cryptography.hazmat.primitives.kdf.pbkdf2 --hidden-import cryptography.hazmat.primitives.hashes --hidden-import cryptography.hazmat.backends --hidden-import pynput --hidden-import pynput.keyboard --hidden-import pystray --hidden-import PIL --hidden-import PIL.Image --hidden-import PIL.ImageDraw --hidden-import PIL.ImageTk --hidden-import json --hidden-import uuid --hidden-import secrets --hidden-import string --hidden-import base64 --hidden-import os --hidden-import shutil --hidden-import datetime --hidden-import threading --hidden-import tree_widget main.py

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

:: Done
echo.
echo ============================================
echo   Build Complete!
echo.
echo   Output: dist\PasswordManager.exe
echo ============================================
echo.
echo Double-click dist\PasswordManager.exe to launch.
echo.
pause
