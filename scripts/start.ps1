Set-Location $PSScriptRoot\..
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "未检测到 Docker，使用本机 Node 启动..."
  npm install
  $env:PORT = if ($env:PORT) { $env:PORT } else { "3001" }
  node server/index.js
  exit
}
docker compose up --build -d
Write-Host "已启动: http://127.0.0.1:3001"
