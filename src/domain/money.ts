import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Formato de Money nos contratos (HTTP, fila, eventos). Nunca `number`. */
export interface MoneyProps {
  amount: string; // string decimal com exatamente 2 casas, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

/**
 * Construtor de Decimal isolado, para não depender da configuração global da lib.
 * Precisão de 40 dígitos significativos cobre com folga os 19 do NUMERIC(19,2),
 * então soma e subtração nunca arredondam. Como Money não multiplica nem divide,
 * o modo de arredondamento nunca chega a ser exercitado.
 */
const ExactDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Entrada aceita: só dígitos, ponto e exatamente 2 casas. Sem sinal, sem zeros
 * à esquerda, sem notação científica. Até 17 dígitos inteiros = NUMERIC(19,2).
 * Uma única grafia por valor mantém o payloadHash da idempotência estável.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Maior valor absoluto representável na coluna NUMERIC(19,2). */
const MAX_ABSOLUTE = new ExactDecimal('99999999999999999.99');

export class Money {
  static readonly SCALE = 2;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Porta de entrada para valores vindos de fora (contratos e banco).
   * Rejeita qualquer coisa fora do formato canônico — inclusive negativos.
   */
  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    const currency: unknown = props?.currency;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal, nunca number');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        // O valor recebido não entra na mensagem: ela vai para logs e para a DLQ.
        `amount fora do formato: dígitos, ponto e exatamente ${Money.SCALE} casas, sem sinal`,
      );
    }
    return new Money(new ExactDecimal(amount), Money.validCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new ExactDecimal(0), Money.validCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.derive(this.value.plus(other.value));
  }

  /** Pode resultar em valor negativo (ex.: diferença na reconciliação). */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.derive(this.value.minus(other.value));
  }

  negate(): Money {
    return this.derive(this.value.negated());
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Igualdade de valor: mesma moeda e mesmo montante. Moedas diferentes nunca são iguais. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(Money.SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(Money.SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  /** Resultado de uma operação: mesma moeda, checado contra o limite da coluna. */
  private derive(value: Decimal): Money {
    if (value.abs().greaterThan(MAX_ABSOLUTE)) {
      throw new InvalidMoneyError('resultado excede o limite de NUMERIC(19,2)');
    }
    return new Money(value, this.currency);
  }

  private static validCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency "${String(currency)}" não é um código ISO-4217 em maiúsculas`);
    }
    return currency;
  }
}
