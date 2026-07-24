# v1.3.7 — Layout das cartas do deck

- Arte da carta passa a ocupar uma coluna fixa e independente.
- Nome e coleção não invadem mais o espaço da imagem.
- Quantidade e botões +/− ficam em área própria, inclusive em telas estreitas.
- Cartas sem arte mantêm um espaço reservado com “Buscando arte…”.

# v1.3.6 — Contraste final e preços em tons pastéis

- Rótulos de Quantidade, Condição, Acabamento, Idioma, armazenamento e demais formulários agora usam texto claro sobre o fundo escuro.
- Legendas dos cartões do painel receberam contraste branco/lilás claro.
- Cartas não possuídas ficaram translúcidas como os Pokémon ausentes da Pokédex, mantendo nomes, números e controles legíveis.
- Preços encontrados usam fundo verde pastel e texto verde-escuro.
- Cartas sem preço usam fundo amarelo pastel e texto marrom-escuro.
- Avisos de validação e botões preservam cores próprias com contraste alto.

# v1.3.5 — Contraste adaptativo e leitura corrigida

- Corrigido texto escuro sobre filtros e campos escuros do Tema Gengar.
- Cartões brancos de cartas, Pokémon e decks usam roxo-escuro de alto contraste.
- Cartas não possuídas não deixam mais o cartão inteiro transparente; apenas a miniatura fica suavizada.
- Selos de quantidade, preço, raridade, wishlist e variantes receberam combinações específicas de fundo e texto.
- Botões de quantidade mantêm símbolos brancos e o número central permanece legível.
- Estados desabilitados e placeholders receberam contraste mínimo consistente.

# v1.3.4 — Contraste dos cartões claros

- Textos, números e rótulos em cartões brancos agora usam roxo-escuro.
- Correção aplicada a cartas, Pokémon registrados, decks, painel, coleções e formulários.
- Campos brancos e placeholders receberam contraste aprimorado.
- Botões ativos, selos e indicadores coloridos preservam suas cores originais.

# v1.3.3 — Safe-area e contraste

- Cabeçalho fixo agora ocupa a área da barra de status do Android.
- Removida a folga vazia entre a borda superior do aparelho e o cabeçalho.
- Espaçamento seguro preservado para relógio, rede, Wi-Fi e bateria.
- Textos e números em superfícies brancas usam roxo-escuro de alto contraste.
- Ajustado contraste de Pokémon registrados, listas de deck e seletores claros.

# v1.3.2 — Wallpaper Gengar e Pokédex nítida

- Mantido o sprite antigo do Gengar no cabeçalho.
- Imagem enviada aplicada como papel de parede fora do cabeçalho, com 20% de transparência.
- Pokémon com cartas registradas aparecem na Pokédex com fundo branco e sprite totalmente nítido.
- Pokémon ainda não registrados permanecem translúcidos.

# v1.3.0 — Tema Gengar

- Tema visual roxo e preto inspirado no Gengar.
- Cabeçalho animado com Gengar, névoa e brilho leve.
- Abas superiores convertidas em botões com ícones.
- Removida a necessidade de navegação inferior.
- Cartões, filtros, formulários, Pokédex, decks e modais adaptados ao novo tema.
- Animações leves, respeitando a configuração de redução de movimento do aparelho.
- Mantidas todas as funções e otimizações de performance da v1.2.

# Fichário Pokémon v1.2.0

- Catálogo otimizado para mais de 23 mil cartas.
- Pesquisa com índice normalizado e debounce de 250 ms.
- Filtros da coleção processam somente cartas cadastradas.
- Apenas 40 cartas são renderizadas inicialmente.
- Miniaturas carregadas de forma assíncrona e sob demanda.
- Banco central de preços deixa de bloquear a abertura do aplicativo.
- Cache de ordenação para catálogo e coleções.
- Cabeçalho e abas unidos em uma única área fixa, eliminando a faixa onde o texto aparecia ao rolar.
