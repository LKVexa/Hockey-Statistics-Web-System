@echo off
setlocal EnableExtensions
rem RINK-VT, LK/Vexa edition: verify the release, its contracts, the host and the league. Writes nothing.
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"
if /i "%ARCH%"=="x86" (
  echo RINK-VT needs 64-bit Windows ^(x64 or ARM64^); this Windows is 32-bit.
  pause
  exit /b 4
)
set "EXE=%~dp0photon\bin\rinkvt-photon-windows-amd64.exe"
if /i "%ARCH%"=="ARM64" set "EXE=%~dp0photon\bin\rinkvt-photon-windows-arm64.exe"
if not exist "%EXE%" (
  echo RINK-VT: "%EXE%" is missing. Unpack the whole release again; it carries the Photon host for this computer.
  pause
  exit /b 4
)
"%EXE%" verify %*
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
