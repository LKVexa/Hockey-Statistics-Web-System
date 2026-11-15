@echo off
setlocal EnableExtensions
rem Rebuild the Photon host for every platform the release carries. Needs the Go toolchain (go.dev); the release
rem already carries the results in photon\bin, so running RINK-VT needs nothing at all. Then reseal: ..\RINKVT.cmd seal
cd /d "%~dp0"
set CGO_ENABLED=0
for %%T in (windows/amd64 windows/arm64 darwin/arm64 darwin/amd64 linux/amd64 linux/arm64) do call :one %%T
exit /b 0
:one
for /f "tokens=1,2 delims=/" %%A in ("%1") do (set "GOOS=%%A" & set "GOARCH=%%B")
set "EXT="
if "%GOOS%"=="windows" set "EXT=.exe"
go build -trimpath -ldflags "-s -w -buildid=" -o "bin\rinkvt-photon-%GOOS%-%GOARCH%%EXT%" .
if errorlevel 1 exit /b 1
echo bin\rinkvt-photon-%GOOS%-%GOARCH%%EXT%
exit /b 0
