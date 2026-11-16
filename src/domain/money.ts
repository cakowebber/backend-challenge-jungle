import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const ExactDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MAX_ABSOLUTE = new ExactDecimal('99999999999999999.99');

export class Money {
  static readonly SCALE = 2;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    const currency: unknown = props?.currency;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal, nunca number');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
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
