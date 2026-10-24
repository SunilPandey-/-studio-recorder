@echo off
rem Starts the Studio Recorder server (no console window) and opens the recorder.
cd /d "%~dp0"
start "" pythonw "%~dp0server.py"
