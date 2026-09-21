def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)


total = 0
for i in range(1, 4):
    total = total + factorial(i)
print(total)
