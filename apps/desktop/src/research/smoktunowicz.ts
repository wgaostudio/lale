// ---------------------------------------------------------------------------
// Smoktunowicz, "There are no graded domains with GK dimension strictly
// between 2 and 3" (Invent. Math. 164, 2006): preparing a test copy
//
// lale reads claims, labels and references; a paper typeset for people says
// "by Lemma 3" in plain text and puts the proof of Theorem 1 at the end. These
// edits add the markup lale needs and supply three standard definitions the
// paper takes for granted. None changes a statement's mathematics or a proof's
// argument. Each edit must apply exactly once, so a different source copy
// fails here instead of producing a quietly different test.
//
// The paper itself is not committed (it is Springer's). The input is a local
// reading copy; the output goes to a gitignored directory.
// ---------------------------------------------------------------------------

export interface Edit {
  why: string;
  find: string;
  replace: string;
}

const DEFINITIONS = String.raw`
% --- lale test copy: supplied definitions (not in the paper) ---------------
\begin{definition}[Gelfand--Kirillov dimension, cf.~\cite{KrauseLenagan}]\label{def:gk}
Let $F$ be a field and $A$ an $F$-algebra. For a finite-dimensional
$F$-subspace $V$ of $A$ put $d_V(m)=\dim_F\bigl(\sum_{i=0}^{m}V^i\bigr)$, where
$V^0=F$. The Gelfand--Kirillov dimension of $A$ over $F$ is
\[
\GKDim A=\sup_{V}\ \limsup_{m\to\infty}\frac{\log d_V(m)}{\log m},
\]
the supremum over all finite-dimensional subspaces $V$ of $A$.
\end{definition}

\begin{definition}[cf.~\cite{ArtinStafford}]\label{def:fg}
A graded $K$-algebra $R=\bigoplus_{n\geq 0}R_n$ is \emph{finitely graded} if it
is a finitely generated algebra and $R_0$ is a finite-dimensional vector space
over $K$.
\end{definition}

\begin{definition}[cf.~\cite{NastasescuVanOystaeyen}]\label{def:q}
Let $R$ be a graded domain in which the nonzero homogeneous elements form an
Ore set. Its \emph{graded quotient ring} $Q(R)$ is the localization of $R$ at
the nonzero homogeneous elements. Its degree-zero part $D$, the fractions
$ab^{-1}$ with $a,b$ homogeneous of the same degree and $b\neq0$, is a
division ring, and $Q(R)=D[z,z^{-1};\sigma]$ for an automorphism $\sigma$ of
$D$ and a homogeneous $z$ of least positive degree.
\end{definition}
% --- end of supplied definitions ---------------------------------------------
`;

export const EDITS: Edit[] = [
  {
    why: 'A definition environment for the supplied definitions.',
    find: String.raw`\newtheorem{lemma}{Lemma}`,
    replace: String.raw`\newtheorem{lemma}{Lemma}
\newtheorem{definition}{Definition}`,
  },
  {
    why: 'GK dimension, "finitely graded" and the graded quotient ring are used throughout; Mathlib has none of them. Placed before Theorem 1 so every claim can cite them.',
    find: 'that this conjecture is true for all fields. We state the main result.',
    replace: `that this conjecture is true for all fields. We state the main result.\n${DEFINITIONS}`,
  },
  {
    why: 'Label Theorem 1, point it at its definitions, and attach its proof (in the paper it closes the article, as "Proof of Theorem 1").',
    find: String.raw`\begin{theorem}
Let $K$ be a field, and let $R$ be a finitely graded $K$-algebra which is a
domain. Then $R$ cannot have Gelfand--Kirillov dimension strictly between 2 and 3.
\end{theorem}`,
    replace: String.raw`\begin{theorem}\label{thm:main}
Let $K$ be a field, and let $R$ be a finitely graded $K$-algebra which is a
domain. Then $R$ cannot have Gelfand--Kirillov dimension strictly between 2 and 3.
(Definitions~\ref{def:gk} and~\ref{def:fg}.)
\end{theorem}
\begin{proof}
It follows from Theorem~\ref{thm:as} (Artin--Stafford's Theorem \cite{ArtinStafford})
and Theorem~\ref{thm:3}.
\end{proof}`,
  },
  {
    why: 'Remove the detached proof of Theorem 1, now attached above.',
    find: String.raw`\noindent\textit{Proof of Theorem 1.}
It follows from Theorem 2 (Artin--Stafford's Theorem \cite{ArtinStafford})
and Theorem 3.`,
    replace: '',
  },
  {
    why: 'Label Theorem 2 (Artin–Stafford) and point it at its definitions.',
    find: String.raw`\begin{theorem}[cf. \cite{ArtinStafford}]
Let $R$ be a finitely graded $K$-algebra and assume that $R$ is an Ore domain
with graded quotient division ring $Q(R)=D[z,z^{-1};\sigma]$. If $\GKDim D<2$
then $\GKDim(R)\leq 2$.`,
    replace: String.raw`\begin{theorem}[cf. \cite{ArtinStafford}]\label{thm:as}
Let $R$ be a finitely graded $K$-algebra and assume that $R$ is an Ore domain
with graded quotient division ring $Q(R)=D[z,z^{-1};\sigma]$. If $\GKDim D<2$
then $\GKDim(R)\leq 2$. (Definitions~\ref{def:gk}, \ref{def:fg} and~\ref{def:q}.)`,
  },
  {
    why: 'Label Lemma 1.',
    find: String.raw`\begin{lemma}
Let $K$ be a field, and let $A$ be a $K$-algebra with $\GKDim A\geq 2$.
Let $a_1,\ldots,a_n$ be generators of $A$, and let $a_1=1$. Denote
$c_i=\sum_{j=1}^{n}x_{i,j}a_j\in A(X)$,
$d_i=\sum_{j=1}^{n}x_{-i,j}a_j\in A(X)$ for $i=1,2,\ldots$.
Let $k$ be a natural number.`,
    replace: String.raw`\begin{lemma}\label{lem:1}
Let $K$ be a field, and let $A$ be a $K$-algebra with $\GKDim A\geq 2$
(Definition~\ref{def:gk}).
Let $a_1,\ldots,a_n$ be generators of $A$, and let $a_1=1$. Denote
$c_i=\sum_{j=1}^{n}x_{i,j}a_j\in A(X)$,
$d_i=\sum_{j=1}^{n}x_{-i,j}a_j\in A(X)$ for $i=1,2,\ldots$.
Let $k$ be a natural number.`,
  },
  {
    why: 'Label Lemma 2.',
    find: String.raw`\begin{lemma}
Let $K$ be a field, and let $A$ be a $K$-algebra with $\GKDim A\geq 2$.
Let $a_1,\ldots,a_n$ be generators of $A$, and let $a_1=1$. Denote
$c_i=\sum_{j=1}^{n}x_{i,j}a_j\in A(X)$,
$d_i=\sum_{j=1}^{n}x_{-i,j}a_j\in A(X)$ for $i=1,2,\ldots$.
Then, for all natural numbers $j,t$,`,
    replace: String.raw`\begin{lemma}\label{lem:2}
Let $K$ be a field, and let $A$ be a $K$-algebra with $\GKDim A\geq 2$
(Definition~\ref{def:gk}).
Let $a_1,\ldots,a_n$ be generators of $A$, and let $a_1=1$. Denote
$c_i=\sum_{j=1}^{n}x_{i,j}a_j\in A(X)$,
$d_i=\sum_{j=1}^{n}x_{-i,j}a_j\in A(X)$ for $i=1,2,\ldots$.
Then, for all natural numbers $j,t$,`,
  },
  {
    why: 'Lemma 2 proof: textual reference to Lemma 1.',
    find: 'Assume on the contrary, and let $k$ be as in Lemma 1.',
    replace: String.raw`Assume on the contrary, and let $k$ be as in Lemma~\ref{lem:1}.`,
  },
  {
    why: 'Lemma 2 proof: textual reference to Lemma 1.',
    find: 'By Lemma 1 applied in the case that',
    replace: String.raw`By Lemma~\ref{lem:1} applied in the case that`,
  },
  {
    why: 'Label Lemma 3 and point it at its definitions.',
    find: String.raw`\begin{lemma}
Let $R=\bigoplus_{n\geq0}R_n$ be a finitely graded $K$-algebra which is a domain
with $\GKDim R<3$,`,
    replace: String.raw`\begin{lemma}\label{lem:3}
Let $R=\bigoplus_{n\geq0}R_n$ be a finitely graded $K$-algebra which is a domain
(Definitions~\ref{def:gk} and~\ref{def:fg}) with $\GKDim R<3$,`,
  },
  {
    why: 'Label Theorem 3 and point it at its definitions.',
    find: String.raw`\begin{theorem}
Let $K$ be a field, and let $R$ be a finitely graded domain with
$\GKDim R<3$ and with graded quotient ring
$Q(R)=D[z,z^{-1};\sigma]$. Then $\GKDim D<2$.`,
    replace: String.raw`\begin{theorem}\label{thm:3}
Let $K$ be a field, and let $R$ be a finitely graded domain with
$\GKDim R<3$ and with graded quotient ring
$Q(R)=D[z,z^{-1};\sigma]$. Then $\GKDim D<2$.
(Definitions~\ref{def:gk}, \ref{def:fg} and~\ref{def:q}.)`,
  },
  {
    why: 'Theorem 3 proof: textual reference to Lemma 3.',
    find: 'By Lemma 3 there is a natural number $s$ such that',
    replace: String.raw`By Lemma~\ref{lem:3} there is a natural number $s$ such that`,
  },
  {
    why: 'Theorem 3 proof: textual reference to Lemma 2.',
    find: 'By Lemma 2, there are',
    replace: String.raw`By Lemma~\ref{lem:2}, there are`,
  },
  {
    why: 'Theorem 3 proof: textual reference to Lemma 3.',
    find: 'It holds for infinitely many $s$ by Lemma 3.',
    replace: String.raw`It holds for infinitely many $s$ by Lemma~\ref{lem:3}.`,
  },
];

/** Claims in the order they must be checked: each after everything it cites. */
export const CHECK_ORDER = ['def:gk', 'def:fg', 'def:q', 'lem:3', 'lem:1', 'lem:2', 'thm:as', 'thm:3', 'thm:main'] as const;

export function prepareTestCopy(source: string): string {
  // Normalize line endings so the anchors, written with \n, match a copy
  // saved on any platform.
  let text = source.replace(/\r\n/g, '\n');
  for (const edit of EDITS) {
    const first = text.indexOf(edit.find);
    if (first < 0) throw new Error(`Edit does not apply (anchor not found): ${edit.why}`);
    if (text.indexOf(edit.find, first + 1) >= 0) throw new Error(`Edit is ambiguous (anchor occurs twice): ${edit.why}`);
    text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
  }
  return `% lale test copy, generated by apps/desktop/src/research/smoktunowicz.ts.\n% Markup and supplied definitions only; see that file for every edit.\n${text}`;
}
