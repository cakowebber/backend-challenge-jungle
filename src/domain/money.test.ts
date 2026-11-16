import { describe, expect, test } from 'bun:test';
import { brl, usd } from '../../test/support/domain-fixtures';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money, type MoneyProps } from './money';

describe('Money.from — entradas válidas', () => {
  test.each(['0.00', '0.01', '25.00', '1000.50', '99999999999999999.99'])('aceita "%s"', (amount) => {
    expect(Money.from({ amount, currency: 'BRL' }).toJSON()).toEqual({ amount, currency: 'BRL' });
  });
});

describe('Money.from — entradas inválidas', () => {
  test.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica com casas', '1.00e2'],
    ['string vazia', ''],
    ['só espaços', '   '],
    ['espaço em volta', ' 25.00 '],
    ['mais de 2 casas', '10.123'],
    ['1 casa só', '10.5'],
    ['sem casas decimais', '10'],
    ['ponto sem casas', '10.'],
    ['sem parte inteira', '.50'],
    ['negativo', '-5.00'],
    ['sinal de mais', '+5.00'],
    ['zero à esquerda', '05.00'],
    ['vírgula decimal', '10,00'],
    ['separador de milhar', '1,000.00'],
    ['hexadecimal', '0x10.00'],
    ['texto', 'abc'],
    ['acima do NUMERIC(19,2)', '100000000000000000.00'],
  ])('rejeita %s', (_caso, amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([
    ['number', 25],
    ['number com decimais', 25.5],
    ['null', null],
    ['undefined', undefined],
    ['objeto', { valor: '25.00' }],
  ])('rejeita amount do tipo %s — dinheiro nunca é number', (_tipo, amount) => {
    const props = { amount, currency: 'BRL' } as unknown as MoneyProps;

    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', 'R$', '986'])('rejeita moeda "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });

  test('rejeita props ausente', () => {
    expect(() => Money.from(undefined as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });
});

describe('Money — aritmética exata', () => {
  test('0.10 + 0.20 é exatamente 0.30 (o caso que quebra com float)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // por isso não usamos number
  });

  test('soma e subtração preservam a escala de 2 casas', () => {
    expect(brl('1000.00').subtract(brl('25.00')).toJSON().amount).toBe('975.00');
    expect(brl('19.99').add(brl('0.01')).toJSON().amount).toBe('20.00');
  });

  test('não perde precisão em valores no limite da coluna', () => {
    const quaseMaximo = brl('99999999999999999.98');

    expect(quaseMaximo.add(brl('0.01')).toJSON().amount).toBe('99999999999999999.99');
    expect(quaseMaximo.subtract(brl('99999999999999999.97')).toJSON().amount).toBe('0.01');
  });

  test('mil somas de um centavo dão exatamente 10.00', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) {
      total = total.add(brl('0.01'));
    }

    expect(total.toJSON().amount).toBe('10.00');
  });

  test('resultado acima do limite da coluna é erro, não arredondamento', () => {
    expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });

  test('subtração pode ficar negativa e serializa com sinal', () => {
    const diferenca = brl('10.00').subtract(brl('15.50'));

    expect(diferenca.isNegative()).toBe(true);
    expect(diferenca.toJSON()).toEqual({ amount: '-5.50', currency: 'BRL' });
  });

  test('negate inverte o sinal e zero continua "0.00"', () => {
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(brl('5.00').negate().negate().equals(brl('5.00'))).toBe(true);
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).negate().toJSON().amount).toBe('0.00');
  });
});

describe('Money — comparações', () => {
  test('isZero, isPositive e isNegative', () => {
    const zero = Money.zero('BRL');
    const negativo = brl('1.00').negate();

    expect([zero.isZero(), zero.isPositive(), zero.isNegative()]).toEqual([true, false, false]);
    expect([brl('0.01').isZero(), brl('0.01').isPositive(), brl('0.01').isNegative()]).toEqual([false, true, false]);
    expect([negativo.isZero(), negativo.isPositive(), negativo.isNegative()]).toEqual([false, false, true]);
  });

  test('isLessThan', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
  });

  test('equals compara valor e moeda', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
  });
});

describe('Money — conflito de moeda', () => {
  test('add, subtract e isLessThan entre moedas diferentes lançam erro de domínio', () => {
    expect(() => brl('10.00').add(usd('10.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('10.00').subtract(usd('10.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('10.00').isLessThan(usd('10.00'))).toThrow(CurrencyMismatchError);
  });

  test('o erro informa as duas moedas', () => {
    try {
      brl('10.00').add(usd('10.00'));
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(error).toMatchObject({ expected: 'BRL', actual: 'USD', code: 'CURRENCY_MISMATCH' });
    }
  });
});

describe('Money — imutabilidade e serialização', () => {
  test('toda operação devolve uma nova instância e preserva a original', () => {
    const original = brl('100.00');

    const soma = original.add(brl('1.00'));
    const subtracao = original.subtract(brl('1.00'));
    const negado = original.negate();

    expect(original.toJSON().amount).toBe('100.00');
    expect(soma).not.toBe(original);
    expect(subtracao).not.toBe(original);
    expect(negado).not.toBe(original);
  });

  test('a instância é congelada', () => {
    const money = brl('100.00');

    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow(TypeError);
    expect(money.currency).toBe('BRL');
  });

  test('toJSON devolve string decimal com 2 casas, nunca number', () => {
    const json = brl('1000.50').toJSON();

    expect(json).toEqual({ amount: '1000.50', currency: 'BRL' });
    expect(typeof json.amount).toBe('string');
    expect(JSON.stringify({ money: brl('25.00') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  test('toString é legível', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });

  test('o que foi serializado reidrata no mesmo valor', () => {
    const original = brl('12345.67');

    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});
