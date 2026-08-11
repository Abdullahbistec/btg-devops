import { NextResponse } from 'next/server'

export const ok = (data: unknown) =>
  NextResponse.json(data)

export const created = (data: unknown) =>
  NextResponse.json(data, { status: 201 })

export const badRequest = (msg: string) =>
  NextResponse.json({ error: msg }, { status: 400 })

export const unauthorized = () =>
  NextResponse.json({ error: 'unauthorized' }, { status: 401 })

export const forbidden = () =>
  NextResponse.json({ error: 'forbidden' }, { status: 403 })

export const notFound = (msg: string) =>
  NextResponse.json({ error: msg }, { status: 404 })

export const serverError = (msg: string) =>
  NextResponse.json({ error: msg }, { status: 500 })
