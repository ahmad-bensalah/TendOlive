@echo off
setlocal
title OliveSoft RAG dashboard
cd /d "%~dp0"

rem ---- find Python 3.10+ ------------------------------------------------
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY goto :nopython
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul || goto :oldpython

rem ---- create the virtual environment once --------------------------------
if not exist ".venv\Scripts\python.exe" (
  echo Creating the virtual environment. This happens only once...
  %PY% -m venv .venv || goto :fail
)

rem ---- install or check the packages ----------------------------------------
echo Checking the packages. The first run downloads about 1 GB, please wait...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :fail

rem ---- start the dashboard (the browser opens by itself) --------------------
".venv\Scripts\python.exe" app.py %*
goto :end

:nopython
echo.
echo Python was not found.
echo Install Python 3.10 or newer from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" during the install. Then run start.bat again.
goto :end

:oldpython
echo.
echo Your Python is older than 3.10. Install Python 3.10 or newer from https://www.python.org/downloads/
goto :end

:fail
echo.
echo Something went wrong. Read the messages above.

:end
echo.
pause
