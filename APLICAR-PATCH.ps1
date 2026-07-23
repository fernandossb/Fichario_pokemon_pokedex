$ErrorActionPreference = 'Stop'
$patchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Get-Location

$index = Join-Path $repo 'app/src/main/assets/www/index.html'
$styles = Join-Path $repo 'app/src/main/assets/www/styles.css'
$build = Join-Path $repo 'app/build.gradle'
$destJs = Join-Path $repo 'app/src/main/assets/www/image-fallback.js'

if (!(Test-Path $index) -or !(Test-Path $styles) -or !(Test-Path $build)) {
  throw 'Abra a pasta principal do repositorio no Explorer, copie este patch para ela e execute novamente.'
}

Copy-Item (Join-Path $patchRoot 'arquivos/image-fallback.js') $destJs -Force

$html = Get-Content $index -Raw
if ($html -notmatch 'image-fallback\.js') {
  $html = $html -replace '<script\s+src="app\.js"></script>', '<script src="app.js"></script>`r`n  <script src="image-fallback.js"></script>'
  Set-Content $index $html -Encoding UTF8
}

$css = Get-Content $styles -Raw
if ($css -notmatch 'Recuperação de artes v12') {
  Add-Content $styles "`r`n" -Encoding UTF8
  Add-Content $styles (Get-Content (Join-Path $patchRoot 'arquivos/image-fallback.css') -Raw) -Encoding UTF8
}

$gradle = Get-Content $build -Raw
$match = [regex]::Match($gradle, 'versionCode\s+(\d+)')
if ($match.Success) {
  $oldCode = [int]$match.Groups[1].Value
  $newCode = $oldCode + 1
  $gradle = [regex]::Replace($gradle, 'versionCode\s+\d+', "versionCode $newCode", 1)
  Set-Content $build $gradle -Encoding UTF8
  Write-Host "versionCode atualizado: $oldCode -> $newCode" -ForegroundColor Green
}

$notes = Join-Path $repo 'RELEASE_NOTES.md'
$releaseText = @"
## Recuperacao de artes
- Busca automatica da arte em portugues e ingles.
- Cache local para cartas antigas e promocionais.
- Botao Recarregar arte quando nenhuma fonte responder.
- Correcao para cartas como Meganium MEP 001 e Numel da Equipe Magma 1/34.
"@
if (Test-Path $notes) {
  $existing = Get-Content $notes -Raw
  if ($existing -notmatch 'Recuperacao de artes') { Set-Content $notes ($releaseText + "`r`n" + $existing) -Encoding UTF8 }
} else {
  Set-Content $notes $releaseText -Encoding UTF8
}

Write-Host ''
Write-Host 'PATCH APLICADO COM SUCESSO.' -ForegroundColor Green
Write-Host 'Arquivos adicionados/alterados:'
Write-Host ' - image-fallback.js'
Write-Host ' - index.html'
Write-Host ' - styles.css'
Write-Host ' - app/build.gradle (versionCode +1)'
Write-Host ' - RELEASE_NOTES.md'
Write-Host ''
Write-Host 'Agora abra o GitHub Desktop, faca Commit e Push origin.' -ForegroundColor Cyan
