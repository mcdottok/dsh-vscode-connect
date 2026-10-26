@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 goto failed
if not exist artifacts mkdir artifacts
if errorlevel 1 goto failed
call npm pack --ignore-scripts --pack-destination artifacts
set "buildResult=%errorlevel%"
popd
exit /b %buildResult%
:failed
popd
exit /b 1
